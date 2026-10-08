/**
 * recall: retrieve spilled artifacts — the other half of "recallable
 * compaction". Truncated tool results and compacted history are never lost;
 * the model pulls them back by locator.
 */

import { ToolError } from "./errors.js";
import type { ToolDef, ToolContext } from "./registry.js";

const RECALL_LIMIT = 100_000;

export const recallTool: ToolDef = {
  name: "recall",
  description:
    'Retrieve the full content of a spilled artifact by its locator (e.g. "artifact:xxx.json"). ' +
    "Use this whenever a tool result was truncated or after compaction, to recover exact earlier content.",
  readonly: true,
  inputSchema: {
    type: "object",
    properties: { locator: { type: "string", description: "Locator string from a truncation notice or compaction summary." } },
    required: ["locator"],
  },
  async execute(input, ctx: ToolContext) {
    const content = ctx.artifacts.read(String(input.locator ?? ""));
    if (content === null) {
      throw new ToolError(`No artifact found for locator "${input.locator}".`);
    }
    if (content.length > RECALL_LIMIT) {
      return (
        content.slice(0, RECALL_LIMIT) +
        `\n\n[[recall: artifact is ${content.length} chars; showing first ${RECALL_LIMIT}.]]`
      );
    }
    return content;
  },
};
