/**
 * Subagent spawner: builds a full child harness loop with its own event log,
 * whitelisted tool registry, and shared permission engine — then returns the
 * child's final message. Everything the child does is journaled to its own
 * append-only log under <parentSessionDir>/subagents/, so delegation never
 * escapes the "Model-visible means logged" invariant.
 */

import * as path from "node:path";
import type { ModelAdapter } from "../core/types.js";
import { EventLog } from "../log/eventlog.js";
import { project } from "../log/projector.js";
import { ArtifactStore } from "../context/artifacts.js";
import { ContextManager, makeAdapterSummarizer } from "../context/manager.js";
import { ReadState } from "../tools/readstate.js";
import { ToolRegistry, type ToolDef, type ToolContext } from "../tools/registry.js";
import type { PermissionEngine } from "../perm/engine.js";
import type { HookRunner } from "../hooks/runner.js";
import { runTurn } from "../core/loop.js";
import { buildBaseSystemPrompt } from "../sysprompt.js";
import { resolveProfile } from "./profiles.js";

export interface SubagentSpawnerConfig {
  parentSessionDir: string;
  cwd: string;
  adapter: ModelAdapter;
  /** Full parent toolset; the profile whitelist filters it for the child. */
  allToolDefs: ToolDef[];
  perm: PermissionEngine;
  hooks: HookRunner;
  pruneBytes: number;
  compactThresholdTokens: number;
  maxSteps: number;
  /** Extra system prompt material (skills catalog, memory). */
  extraSystem?: string;
}

export function makeSubagentSpawner(cfg: SubagentSpawnerConfig) {
  return async (input: { agent?: string; description?: string; prompt: string }): Promise<string> => {
    const profile = resolveProfile(input.agent);
    if (!input.prompt?.trim()) {
      throw new Error("task requires a prompt describing what the subagent should do.");
    }

    const childLog = EventLog.create(path.join(cfg.parentSessionDir, "subagents"), {
      cwd: cfg.cwd,
      model: cfg.adapter.model,
      provider: `subagent:${profile.name}`,
    });
    const childArtifacts = new ArtifactStore(path.join(childLog.sessionDir, "artifacts"));
    const childCtx: ToolContext = {
      cwd: cfg.cwd,
      sessionDir: childLog.sessionDir,
      artifacts: childArtifacts,
      readState: new ReadState(),
      jobs: new Map(),
      io: {},
    };

    const defs = cfg.allToolDefs.filter((d) => profile.tools.includes(d.name));
    const registry = new ToolRegistry(defs, childCtx, cfg.pruneBytes);

    const system =
      buildBaseSystemPrompt() +
      "\n\n" + profile.systemPrompt +
      (cfg.extraSystem ? `\n\n${cfg.extraSystem}` : "");

    const ctxManager = new ContextManager({
      log: childLog,
      artifacts: childArtifacts,
      summarizer: makeAdapterSummarizer(cfg.adapter),
      thresholdTokens: cfg.compactThresholdTokens,
    });

    const task = `${input.prompt}${input.description ? `\n\n(Delegated task: ${input.description})` : ""}`;
    await runTurn(
      {
        log: childLog,
        adapter: cfg.adapter,
        registry,
        perm: cfg.perm, // shared engine: the parent's rules/modes gate the child too
        hooks: cfg.hooks,
        ctx: childCtx,
        ctxManager,
        io: { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onNotice: () => {} },
        maxSteps: cfg.maxSteps,
        buildSystem: () => system,
      },
      task,
    );

    // The child's final assistant message is the delegation result.
    const events = childLog.list();
    let final = "(subagent produced no final message)";
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.t === "assistant/message" && ev.text && ev.text.trim()) {
        final = ev.text.trim();
        break;
      }
    }
    // Keep the projection honest for replay tooling: nothing hidden, only the
    // return message is what the parent context receives.
    void project(events);
    return `${final}\n\n[[subagent log: ${path.join(childLog.sessionDir, "log.jsonl")}]]`;
  };
}
