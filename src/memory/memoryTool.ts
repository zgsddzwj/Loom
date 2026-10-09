/**
 * The `memory` tool: durable, cross-session facts the model chooses to keep.
 * File-backed (default ~/.loom/memory.md) — user-editable plain markdown.
 * makeMemoryTool() allows tests to point at a temp file.
 */

import { ToolError } from "../tools/errors.js";
import type { ToolDef } from "../tools/registry.js";
import { appendMemory, loadMemory, memoryFile } from "./store.js";

export function makeMemoryTool(file = memoryFile()): ToolDef {
  return {
    name: "memory",
    description:
      "Persist a durable fact to cross-session memory (loaded into every future session) or read " +
      "current memory. Use append for user preferences, project conventions, and decisions that " +
      "must outlive this session. The file is " +
      "~/.loom/memory.md (the user can edit it directly).",
    readonly: true,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["append", "read"], description: "append or read (default read)." },
        fact: { type: "string", description: "For append: one concise, self-contained fact line." },
      },
    },
    async execute(input) {
      const action = String(input.action ?? "read");
      if (action === "read") {
        const content = loadMemory(file);
        return content || `(cross-session memory is empty — file: ${file})`;
      }
      if (action === "append") {
        const fact = String(input.fact ?? "").trim();
        if (!fact) throw new ToolError("append requires a non-empty fact.");
        return appendMemory(fact, file);
      }
      throw new ToolError(`Unknown action "${action}" (append | read).`);
    },
  };
}

export const memoryTool: ToolDef = makeMemoryTool();
