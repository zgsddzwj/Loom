/**
 * The agent loop.
 *
 * Definitions (inherited from dsh): a STEP is one model request plus the
 * tool calls it makes; a TURN is zero or more steps, opened by a user input
 * and closed when the model stops calling tools.
 *
 * Everything the model sees or does passes through the event log: injected
 * context, assistant messages, tool results, compaction. The loop never
 * talks to the model except via projections of the log.
 */

import type { ModelAdapter, ToolCall, TokenUsage } from "./types.js";
import type { EventLog } from "../log/eventlog.js";
import { project } from "../log/projector.js";
import type { ToolRegistry, ToolContext } from "../tools/registry.js";
import type { PermissionEngine } from "../perm/engine.js";
import type { HookRunner } from "../hooks/runner.js";
import type { ContextManager } from "../context/manager.js";

export interface LoopIO {
  onText(delta: string): void;
  onToolCall(call: ToolCall): void;
  onToolResult(r: { callId: string; content: string; isError: boolean }): void;
  onNotice(text: string): void;
  onTurnEnd?(info: { steps: number; stopReason: string; usage?: TokenUsage }): void;
  ask?(desc: string): Promise<boolean>;
  approvePlan?(plan: string): Promise<boolean>;
}

export interface LoopDeps {
  log: EventLog;
  adapter: ModelAdapter;
  registry: ToolRegistry;
  perm: PermissionEngine;
  hooks: HookRunner;
  ctx: ToolContext;
  ctxManager: ContextManager;
  io: LoopIO;
  maxSteps: number;
  buildSystem(): string;
  signal?: AbortSignal;
}

export interface TurnResult {
  steps: number;
  endReason: "end_turn" | "max_steps" | "blocked_prompt" | "aborted";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runTurn(deps: LoopDeps, userInput: string | null): Promise<TurnResult> {
  const { log, io } = deps;
  log.append({ t: "turn/start", source: userInput === null ? "resume" : "user" });

  if (userInput !== null) {
    const h = await deps.hooks.run("UserPromptSubmit", { prompt: userInput });
    if (h.blocked) {
      log.append({ t: "turn/end", reason: `blocked by UserPromptSubmit hook: ${h.reason ?? ""}` });
      io.onNotice(`Prompt blocked by hook: ${h.reason ?? ""}`);
      return { steps: 0, endReason: "blocked_prompt" };
    }
    if (h.additionalContext) {
      log.append({ t: "context/message", kind: "injected", text: h.additionalContext });
    }
    log.append({ t: "user/message", text: userInput });
  }

  let steps = 0;
  let stopHookBudget = 1;

  while (steps < deps.maxSteps) {
    // Context engineering: compact (recallably) before building the request.
    const tools = deps.registry.schemas();
    const system = deps.buildSystem();
    const preMessages = project(log.list()).messages;
    const compacted = await deps.ctxManager.maybeCompact(system, preMessages, tools);
    const messages = compacted ? project(log.list()).messages : preMessages;

    // One model request, with bounded retries on transport errors.
    let text = "";
    let calls: ToolCall[] = [];
    let stopReason = "end_turn";
    let usage: TokenUsage | undefined;
    let got = false;
    for (let attempt = 1; attempt <= 3 && !got; attempt++) {
      text = "";
      calls = [];
      try {
        for await (const ev of deps.adapter.complete({
          system,
          messages,
          tools,
          signal: deps.signal,
        })) {
          if (ev.type === "text") {
            text += ev.delta;
            io.onText(ev.delta);
          } else if (ev.type === "tool_use") {
            calls.push({ id: ev.id, name: ev.name, input: ev.input });
          } else if (ev.type === "done") {
            stopReason = ev.stopReason;
            usage = ev.usage;
          }
        }
        got = true;
      } catch (e) {
        if (deps.signal?.aborted) {
          // Interrupted: journal the partial assistant message so the log
          // still matches everything the model actually said.
          if (text) {
            log.append({ t: "assistant/message", text, toolCalls: [], stopReason: "aborted" });
          }
          log.append({ t: "turn/end", reason: "aborted by user" });
          return { steps, endReason: "aborted" };
        }
        if (attempt === 3) throw e;
        io.onNotice(`model request failed (${(e as Error).message}); retrying ${attempt}/3...`);
        await sleep(1000 * attempt);
      }
    }

    steps++;
    log.append({ t: "assistant/message", text, toolCalls: calls, stopReason, usage });

    if (calls.length === 0) {
      if (stopHookBudget > 0) {
        const h = await deps.hooks.run("Stop", { reason: stopReason });
        if (h.blocked) {
          stopHookBudget--;
          log.append({
            t: "context/message",
            kind: "system-notice",
            text: `The Stop hook blocked ending the turn${h.reason ? ` (${h.reason})` : ""}. Continue working on the task.`,
          });
          continue;
        }
      }
      log.append({ t: "turn/end", reason: stopReason });
      io.onTurnEnd?.({ steps, stopReason, usage });
      return { steps, endReason: "end_turn" };
    }

    for (const call of calls) {
      io.onToolCall(call);

      const pre = await deps.hooks.run("PreToolUse", { tool: call.name, input: call.input });
      if (pre.blocked) {
        const content = `Blocked by PreToolUse hook: ${pre.reason ?? ""}`;
        log.append({ t: "tool/result", callId: call.id, content, isError: true });
        io.onToolResult({ callId: call.id, content, isError: true });
        continue;
      }

      const def = deps.registry.get(call.name);
      if (!def) {
        const content = `Unknown tool "${call.name}". Available: ${deps.registry.names().join(", ")}.`;
        log.append({ t: "tool/result", callId: call.id, content, isError: true });
        io.onToolResult({ callId: call.id, content, isError: true });
        continue;
      }

      const decision = await deps.perm.check(def, call.input ?? {});
      if (decision.effect === "deny") {
        const content = `Permission denied: ${decision.reason ?? "not allowed"}.`;
        log.append({ t: "tool/result", callId: call.id, content, isError: true });
        io.onToolResult({ callId: call.id, content, isError: true });
        continue;
      }

      const out = await deps.registry.execute(call);
      log.append({
        t: "tool/result",
        callId: call.id,
        content: out.content,
        isError: out.isError || undefined,
        locator: out.locator,
      });
      io.onToolResult({ callId: call.id, content: out.content, isError: out.isError });

      if (out.isError) {
        await deps.hooks.run("PostToolUseFailure", { tool: call.name, input: call.input, error: out.content });
      } else {
        await deps.hooks.run("PostToolUse", { tool: call.name, input: call.input, result: out.content });
      }

      // Plan-mode gate: an approved exit_plan flips the permission mode.
      if (call.name === "exit_plan" && !out.isError && out.content.startsWith("PLAN APPROVED")) {
        deps.perm.setMode("acceptEdits");
        deps.ctx.planGate = undefined;
        log.append({
          t: "context/message",
          kind: "system-notice",
          text: "User approved the plan; permission mode switched to acceptEdits. Execute the plan now.",
        });
        io.onNotice("Plan approved — mode switched to acceptEdits.");
      }
    }
  }

  log.append({ t: "turn/end", reason: "max_steps" });
  io.onNotice(`Turn ended after reaching the ${deps.maxSteps}-step limit.`);
  return { steps, endReason: "max_steps" };
}
