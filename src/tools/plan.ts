/**
 * exit_plan: the plan-mode approval gate (Claude Code style).
 *
 * In plan mode the agent can only research (read-only tools); when its plan
 * is ready it calls exit_plan, the USER approves interactively, and the
 * harness switches the permission mode to execution. The gate lives in the
 * harness — the model cannot self-approve.
 */

import { ToolError } from "./errors.js";
import type { ToolDef, ToolContext } from "./registry.js";

export const exitPlanTool: ToolDef = {
  name: "exit_plan",
  description:
    "Present your implementation plan for user approval. Only available in plan mode. " +
    "The plan should be concrete and complete enough to execute as-is. " +
    "Approval switches the harness to execution mode automatically.",
  readonly: true,
  inputSchema: {
    type: "object",
    properties: {
      plan: { type: "string", description: "The complete implementation plan in markdown." },
    },
    required: ["plan"],
  },
  async execute(input, ctx: ToolContext) {
    if (!ctx.planGate) {
      throw new ToolError(
        "Plan approval gate unavailable: exit_plan requires an interactive session in plan mode " +
          "(in headless mode there is no way for the user to approve a plan — fail-closed).",
      );
    }
    const approved = await ctx.planGate.approve(String(input.plan ?? ""));
    if (approved) {
      return "PLAN APPROVED — the user accepted your plan and the permission mode has been switched. Execute the plan now.";
    }
    return "PLAN REJECTED — the user asked for changes. Revise the plan and call exit_plan again with an updated plan.";
  },
};
