/**
 * File tools: read / edit / write.
 *
 * Discipline inherited from Claude Code:
 * - read returns line-numbered content so the model can reference lines;
 * - edit requires a prior read (mechanically enforced via ReadState),
 *   matches exact strings, and refuses ambiguous (non-unique) matches
 *   unless replace_all is set;
 * - write allows new files but requires a read before overwriting.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ReadState } from "./readstate.js";
import { ToolError } from "./errors.js";
import type { ToolDef, ToolContext } from "./registry.js";

export function resolvePath(cwd: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  return abs;
}

export const readTool: ToolDef = {
  name: "read",
  description:
    "Read a text file, returning content prefixed with line numbers. " +
    "Reads up to 2000 lines by default; use offset/limit for more. " +
    "ALWAYS read a file before editing it — the edit tool will refuse otherwise.",
  readonly: true,
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Absolute path, or relative to the workspace root." },
      offset: { type: "number", description: "1-based starting line (default 1)." },
      limit: { type: "number", description: "Max lines to return (default 2000)." },
    },
    required: ["file"],
  },
  async execute(input, ctx: ToolContext) {
    const p = resolvePath(ctx.cwd, String(input.file));
    let text: string;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        throw new ToolError(`${p} is a directory. Use glob or grep to explore directories.`);
      }
      text = fs.readFileSync(p, "utf8");
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(`Cannot read ${p}: ${(e as Error).message}`);
    }
    ctx.readState.record(p);
    const lines = text.split("\n");
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit = Math.min(2000, Math.max(1, Number(input.limit ?? 2000)));
    const end = Math.min(lines.length, offset - 1 + limit);
    let out = "";
    for (let i = offset - 1; i < end; i++) {
      out += `${String(i + 1).padStart(6)}\u2192${lines[i]}\n`;
    }
    if (end < lines.length) {
      out += `\n[${lines.length - end} more lines. Call read again with offset=${end + 1}.]`;
    }
    return out || "(empty file)";
  },
};

export const editTool: ToolDef = {
  name: "edit",
  description:
    "Edit a file by replacing an exact string. The file MUST have been read in this session " +
    "first (enforced mechanically). old_string must match exactly (including whitespace) and " +
    "be unique in the file, unless replace_all is true.",
  readonly: false,
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Path of the file to edit." },
      old_string: { type: "string", description: "Exact text to replace (copy it verbatim from read output, without the line-number prefixes)." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["file", "old_string", "new_string"],
  },
  async execute(input, ctx: ToolContext) {
    const p = resolvePath(ctx.cwd, String(input.file));
    ctx.readState.assertEditable(p);
    const oldS = String(input.old_string);
    const newS = String(input.new_string);
    if (oldS === newS) throw new ToolError("old_string and new_string are identical.");
    const text = fs.readFileSync(p, "utf8");
    const count = oldS ? text.split(oldS).length - 1 : 0;
    if (count === 0) {
      throw new ToolError(
        `old_string not found in ${p}. Read the file again and copy the exact text ` +
          `(remember to strip the line-number prefixes from read output).`,
      );
    }
    const replaceAll = Boolean(input.replace_all);
    if (count > 1 && !replaceAll) {
      throw new ToolError(
        `old_string is not unique (${count} occurrences in ${p}). Include more surrounding ` +
          `context to make it unique, or set replace_all: true.`,
      );
    }
    const updated = replaceAll ? text.split(oldS).join(newS) : text.replace(oldS, newS);
    fs.writeFileSync(p, updated, "utf8");
    ctx.readState.record(p);
    return `OK: replaced ${replaceAll ? count : 1} occurrence(s) in ${p}.`;
  },
};

export const writeTool: ToolDef = {
  name: "write",
  description:
    "Create a file (or fully overwrite one that was read earlier in this session). " +
    "For partial changes prefer edit. Parent directories are created automatically.",
  readonly: false,
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Path of the file to write." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["file", "content"],
  },
  async execute(input, ctx: ToolContext) {
    const p = resolvePath(ctx.cwd, String(input.file));
    ctx.readState.assertWritable(p);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const content = String(input.content);
    fs.writeFileSync(p, content, "utf8");
    ctx.readState.record(p);
    return `OK: wrote ${Buffer.byteLength(content)} bytes to ${p}.`;
  },
};
