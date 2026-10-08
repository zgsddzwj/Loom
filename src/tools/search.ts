/**
 * Search tools: glob + grep.
 *
 * Uses ripgrep when available (harness bundles none — PATH rg preferred for
 * speed), with a pure-JS fallback so behavior is identical everywhere.
 * Results are capped to keep context small (pruner spills anything huge).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDef, ToolContext } from "./registry.js";

export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++;
        re += ".*";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((alt) => alt.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = end;
      } else {
        re += "\\{";
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".venv", "__pycache__"]);

export function walkFiles(root: string, maxEntries = 20_000): string[] {
  const out: string[] = [];
  const queue: string[] = [root];
  while (queue.length && out.length < maxEntries) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(full);
      } else {
        out.push(path.relative(root, full));
        if (out.length >= maxEntries) break;
      }
    }
  }
  return out;
}

export const globTool: ToolDef = {
  name: "glob",
  description:
    "Find files matching a glob pattern (supports **, *, ?, {a,b}). " +
    "Returns workspace-relative paths, sorted, capped at 200. Skips node_modules/.git/dist.",
  readonly: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: 'Glob pattern, e.g. "src/**/*.ts".' },
      path: { type: "string", description: "Directory to search (default: workspace root)." },
    },
    required: ["pattern"],
  },
  async execute(input, ctx: ToolContext) {
    const root = path.resolve(ctx.cwd, String(input.path ?? "."));
    const re = globToRegex(String(input.pattern));
    const matches = walkFiles(root).filter((f) => re.test(f)).sort().slice(0, 200);
    if (matches.length === 0) return `No files matching ${input.pattern} under ${root}.`;
    return matches.join("\n") + `\n[${matches.length} file(s)]`;
  },
};

/**
 * spawnSync does NOT throw when the binary is missing — it sets r.error.
 * A naive try/catch here once made Loom report "No matches" on machines
 * without ripgrep; the detection must check r.error.
 */
let rgAvailable: boolean | undefined;
function hasRg(): boolean {
  if (rgAvailable === undefined) {
    const r = spawnSync("rg", ["--version"], { stdio: "ignore" });
    rgAvailable = !r.error;
  }
  return rgAvailable;
}

/** Pure-JS grep used when ripgrep is unavailable — exported for direct testing. */
export function grepWithJs(
  pattern: string,
  root: string,
  opts: { glob?: string; ignoreCase?: boolean; cwd: string },
): string {
  const flags = opts.ignoreCase ? "i" : "";
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (e) {
    throw new Error(`Invalid regex: ${(e as Error).message}`);
  }
  const files: string[] = [];
  if (fs.statSync(root).isDirectory()) {
    const gRe = opts.glob ? globToRegex(opts.glob) : null;
    for (const f of walkFiles(root)) {
      if (!gRe || gRe.test(path.basename(f))) files.push(path.join(root, f));
    }
  } else {
    files.push(root);
  }
  const results: string[] = [];
  outer: for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // skip binary
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        results.push(`${path.relative(opts.cwd, f)}:${i + 1}:${lines[i].slice(0, 240)}`);
        if (results.length >= 200) break outer;
      }
    }
  }
  if (results.length === 0) return `No matches for /${pattern}/${flags} under ${root}.`;
  return results.join("\n") + `\n[${results.length} match(es), capped at 200]`;
}

export const grepTool: ToolDef = {
  name: "grep",
  description:
    "Search file contents with a regular expression (Rust regex syntax when ripgrep is " +
    "installed). Returns file:line:match, capped at 200 matches. Use glob to filter file names.",
  readonly: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "File or directory to search (default: workspace root)." },
      glob: { type: "string", description: 'Filename filter, e.g. "*.ts".' },
      ignore_case: { type: "boolean", description: "Case-insensitive matching (default false)." },
    },
    required: ["pattern"],
  },
  async execute(input, ctx: ToolContext) {
    const pattern = String(input.pattern);
    const root = path.resolve(ctx.cwd, String(input.path ?? "."));
    const ignoreCase = Boolean(input.ignore_case);
    const flags = ignoreCase ? "i" : "";

    if (hasRg()) {
      const args = ["-n", "--no-heading", "--color", "never"];
      if (ignoreCase) args.push("-i");
      if (input.glob) args.push("-g", String(input.glob));
      args.push("--", pattern, root);
      const r = spawnSync("rg", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      // Any spawn failure (missing binary, EACCES, ...) must fall back to the
      // JS implementation — never silently report "No matches".
      if (!r.error) {
        if (r.status === 2) throw new Error(r.stderr || "ripgrep failed");
        const lines = (r.stdout || "").split("\n").filter(Boolean).slice(0, 200);
        if (lines.length === 0) return `No matches for /${pattern}/${flags} under ${root}.`;
        return lines.join("\n") + `\n[${lines.length} match(es), capped at 200]`;
      }
    }

    return grepWithJs(pattern, root, { glob: input.glob ? String(input.glob) : undefined, ignoreCase, cwd: ctx.cwd });
  },
};
