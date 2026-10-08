/**
 * Tool registry: definitions, shared context, and the executor that applies
 * pre-pruning to every result before it enters the log (so nothing oversized
 * ever reaches the model's context).
 */

import type { ToolCall, ToolSchema } from "../core/types.js";
import { pruneToolResult } from "../context/pruner.js";
import { ArtifactStore } from "../context/artifacts.js";
import { ReadState } from "./readstate.js";
import type { Job } from "./bash.js";
import type { TodoItem } from "./todo.js";
import { ToolError } from "./errors.js";

export interface ToolIO {
  onTodo?(todos: TodoItem[]): void;
}

export interface PlanGate {
  approve(plan: string): Promise<boolean>;
}

export interface ToolContext {
  cwd: string;
  sessionDir: string;
  artifacts: ArtifactStore;
  readState: ReadState;
  jobs: Map<string, Job>;
  io: ToolIO;
  planGate?: PlanGate;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Read-only tools are allowed in every permission mode, including plan mode. */
  readonly: boolean;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface ExecOutcome {
  content: string;
  isError: boolean;
  locator?: string;
}

export class ToolRegistry {
  constructor(
    private defs: ToolDef[],
    private ctx: ToolContext,
    private pruneBytes = 30_000,
  ) {}

  schemas(): ToolSchema[] {
    return this.defs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }));
  }

  get(name: string): ToolDef | undefined {
    return this.defs.find((d) => d.name === name);
  }

  names(): string[] {
    return this.defs.map((d) => d.name);
  }

  async execute(call: ToolCall): Promise<ExecOutcome> {
    const def = this.get(call.name);
    if (!def) {
      return {
        content: `Unknown tool "${call.name}". Available tools: ${this.names().join(", ")}.`,
        isError: true,
      };
    }
    try {
      const raw = await def.execute(call.input ?? {}, this.ctx);
      const pruned = pruneToolResult(raw, this.pruneBytes, this.ctx.artifacts);
      return { content: pruned.content, isError: false, locator: pruned.locator };
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : `${(e as Error)?.message ?? String(e)}`;
      return { content: `Error: ${msg}`, isError: true };
    }
  }
}
