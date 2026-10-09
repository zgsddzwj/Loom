/**
 * The `task` tool: delegate to a subagent. The spawner itself is injected via
 * ToolContext by the CLI (or tests), keeping the tool free of wiring details.
 */

import { ToolError } from "./errors.js";
import type { ToolDef, ToolContext } from "./registry.js";
import { SUBAGENT_PROFILES } from "../subagents/profiles.js";

export const taskTool: ToolDef = {
  name: "task",
  description:
    "Delegate a self-contained task to a subagent with its own context window; its final message " +
    "is returned to you (its full transcript is journaled). Choose the agent by job:\n" +
    Object.values(SUBAGENT_PROFILES)
      .map((p) => `- "${p.name}": ${p.description}`)
      .join("\n") +
    "\nUse subagents for broad searches and large outputs you do NOT need verbatim in your own context.",
  readonly: false, // a general-profile child can write files, so plan mode gates this tool
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short (3-5 word) summary of the delegated task." },
      prompt: { type: "string", description: "Complete, self-contained instructions for the subagent." },
      agent: {
        type: "string",
        enum: ["general", "explore", "judge"],
        description: "Profile to run (default general).",
      },
    },
    required: ["prompt"],
  },
  async execute(input, ctx: ToolContext) {
    if (!ctx.spawnSubagent) {
      throw new ToolError("Subagents are not configured in this session.");
    }
    return ctx.spawnSubagent({
      agent: input.agent ? String(input.agent) : undefined,
      description: input.description ? String(input.description) : undefined,
      prompt: String(input.prompt ?? ""),
    });
  },
};
