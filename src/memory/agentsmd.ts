/**
 * AGENTS.md loading with a hard budget (dsh policy):
 * - candidates ordered broad -> specific (user-global first, then project
 *   files walking up from cwd);
 * - when over budget, broader files are omitted entirely first; the most
 *   specific file is truncated last;
 * - CLAUDE.md works as a fallback name (one home per fact: prefer editing
 *   AGENTS.md).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function loadAgentInstructions(cwd: string, budgetBytes = 65_536): string {
  const candidates: Array<{ path: string; text: string }> = [];

  const userFile = path.join(os.homedir(), ".loom", "AGENTS.md");
  if (fs.existsSync(userFile)) candidates.push({ path: userFile, text: fs.readFileSync(userFile, "utf8") });

  // Walk up from cwd, collecting AGENTS.md / CLAUDE.md (deepest = most specific).
  const projectFiles: Array<{ path: string; text: string }> = [];
  let dir = path.resolve(cwd);
  while (true) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        projectFiles.push({ path: p, text: fs.readFileSync(p, "utf8") });
        break;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // projectFiles is deepest-first; broad->specific order = reversed.
  candidates.push(...projectFiles.reverse());

  // Budget: drop broadest files first; truncate the most specific last.
  let total = candidates.reduce((n, c) => n + Buffer.byteLength(c.text, "utf8"), 0);
  while (total > budgetBytes && candidates.length > 1) {
    const dropped = candidates.shift()!;
    total -= Buffer.byteLength(dropped.text, "utf8");
  }
  const parts = candidates.map((c) => {
    let text = c.text;
    if (Buffer.byteLength(text, "utf8") > budgetBytes) {
      text = text.slice(0, budgetBytes) + "\n[[...truncated by Loom's 64KB instruction budget]]";
    }
    return `===== instructions from ${path.relative(cwd, c.path) || c.path} =====\n${text}`;
  });
  return parts.join("\n\n");
}
