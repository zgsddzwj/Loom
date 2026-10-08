/** Todo tool: task-list discipline for multi-step work (Claude Code style). */

import type { ToolDef, ToolContext } from "./registry.js";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export const todoTool: ToolDef = {
  name: "todo",
  description:
    "Maintain the task list for multi-step work. Pass the FULL list on every call. " +
    "Keep exactly one item in_progress; mark items completed as soon as they are done. " +
    "Use this for any task with 3 or more steps — it keeps you focused and gives the " +
    "user visible progress.",
  readonly: true,
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete current task list.",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async execute(input, ctx: ToolContext) {
    const todos = (input.todos ?? []) as TodoItem[];
    const done = todos.filter((t) => t.status === "completed").length;
    const inProg = todos.filter((t) => t.status === "in_progress").length;
    if (inProg > 1) {
      return (
        `OK: task list updated, but note you marked ${inProg} items in_progress — ` +
        `keep exactly one in_progress at a time.`
      );
    }
    ctx.io.onTodo?.(todos);
    return `OK: ${todos.length} todo(s) — ${done} completed, ${todos.length - done} remaining.`;
  },
};
