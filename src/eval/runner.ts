/**
 * loom eval — reproducible benchmark runner (dsh's BENCHMARK.md principle:
 * provide the mechanism, keep runs replayable from logs).
 *
 * A task directory contains:
 *   task.md     — the instruction sent to the model (verbatim)
 *   fixture/    — optional files copied into a fresh isolated workspace
 *   setup.sh    — optional, runs in the workspace before the turn
 *   verify.sh   — runs after the turn; exit 0 = PASS
 *
 * Each task gets its own temp workspace and its own append-only session, so
 * every eval run is fully replayable later. The runner takes an injected
 * model adapter — tests drive it with the scripted adapter, `loom eval`
 * wires a real provider.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelAdapter } from "../core/types.js";
import { EventLog } from "../log/eventlog.js";
import { ArtifactStore } from "../context/artifacts.js";
import { ContextManager, makeAdapterSummarizer } from "../context/manager.js";
import { ReadState } from "../tools/readstate.js";
import { ToolRegistry, type ToolDef, type ToolContext } from "../tools/registry.js";
import { PermissionEngine } from "../perm/engine.js";
import { HookRunner } from "../hooks/runner.js";
import { runTurn } from "../core/loop.js";
import { buildSystemPrompt } from "../sysprompt.js";
import { loadAgentInstructions } from "../memory/agentsmd.js";
import { makeSubagentSpawner } from "../subagents/spawn.js";
import type { Sandbox } from "../sandbox/sandbox.js";

export interface EvalDeps {
  adapter: ModelAdapter;
  allToolDefs: ToolDef[];
  pruneBytes?: number;
  compactThresholdTokens?: number;
  maxSteps?: number;
  /** Sandbox for bash during eval runs (recommended); null disables. */
  sandboxFor?: (workspace: string, sessionDir: string) => Sandbox | null;
  extraSystem?: string;
}

export interface EvalResult {
  task: string;
  pass: boolean;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  verifyExit: number | null;
  verifyOutput: string;
  sessionDir: string;
  workspace: string;
  durationMs: number;
}

function copyDir(src: string, dst: string): void {
  fs.cpSync(src, dst, { recursive: true });
}

function runShell(file: string, cwd: string, timeoutMs = 300_000): { status: number | null; output: string } {
  const r = spawnSync("/bin/bash", [file], { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return { status: r.status, output: ((r.stdout || "") + (r.stderr || "")).slice(-4000) };
}

export async function runEval(tasksRoot: string, deps: EvalDeps): Promise<EvalResult[]> {
  const taskNames = fs
    .readdirSync(tasksRoot)
    .filter((n) => fs.existsSync(path.join(tasksRoot, n, "task.md")))
    .sort();
  if (taskNames.length === 0) throw new Error(`No eval tasks (*/task.md) under ${tasksRoot}`);

  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-eval-sessions-"));
  const results: EvalResult[] = [];

  for (const name of taskNames) {
    const dir = path.join(tasksRoot, name);
    const started = Date.now();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `loom-eval-${name}-`));
    const fixture = path.join(dir, "fixture");
    if (fs.existsSync(fixture)) copyDir(fixture, workspace);
    const setup = path.join(dir, "setup.sh");
    if (fs.existsSync(setup)) runShell(setup, workspace, 600_000);

    const log = EventLog.create(sessionsRoot, {
      cwd: workspace,
      model: deps.adapter.model,
      provider: "eval",
    });
    const artifacts = new ArtifactStore(path.join(log.sessionDir, "artifacts"));
    const readState = new ReadState();
    const jobs = new Map();
    const ctx: ToolContext = {
      cwd: workspace,
      sessionDir: log.sessionDir,
      artifacts,
      readState,
      jobs,
      io: {},
      spawnSubagent: makeSubagentSpawner({
        parentSessionDir: log.sessionDir,
        cwd: workspace,
        adapter: deps.adapter,
        allToolDefs: deps.allToolDefs,
        perm: new PermissionEngine("bypassPermissions", []),
        hooks: new HookRunner({}, workspace),
        pruneBytes: deps.pruneBytes ?? 30_000,
        compactThresholdTokens: deps.compactThresholdTokens ?? 50_000,
        maxSteps: 40,
        extraSystem: deps.extraSystem,
      }),
    };
    const sb = deps.sandboxFor ? deps.sandboxFor(workspace, log.sessionDir) : null;
    if (sb) ctx.sandboxWrap = (cmd) => sb.wrap(cmd);

    const registry = new ToolRegistry(deps.allToolDefs, ctx, deps.pruneBytes ?? 30_000);
    const ctxManager = new ContextManager({
      log,
      artifacts,
      summarizer: makeAdapterSummarizer(deps.adapter),
      thresholdTokens: deps.compactThresholdTokens ?? 50_000,
    });
    const system = buildSystemPrompt(loadAgentInstructions(workspace)) +
      (deps.extraSystem ? `\n\n${deps.extraSystem}` : "");

    const instruction = fs.readFileSync(path.join(dir, "task.md"), "utf8").trim();
    const turn = await runTurn(
      {
        log,
        adapter: deps.adapter,
        registry,
        perm: new PermissionEngine("bypassPermissions", []),
        hooks: new HookRunner({}, workspace),
        ctx,
        ctxManager,
        io: { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onNotice: () => {} },
        maxSteps: deps.maxSteps ?? 60,
        buildSystem: () => system,
      },
      instruction,
    );

    const verify = runShell(path.join(dir, "verify.sh"), workspace);

    let inputTokens = 0;
    let outputTokens = 0;
    for (const ev of log.list()) {
      if (ev.t === "assistant/message" && ev.usage) {
        inputTokens += ev.usage.input ?? 0;
        outputTokens += ev.usage.output ?? 0;
      }
    }

    results.push({
      task: name,
      pass: verify.status === 0,
      steps: turn.steps,
      inputTokens,
      outputTokens,
      verifyExit: verify.status,
      verifyOutput: verify.output.trim(),
      sessionDir: log.sessionDir,
      workspace,
      durationMs: Date.now() - started,
    });
  }

  const resultsFile = path.join(tasksRoot, "eval-results.jsonl");
  fs.writeFileSync(
    resultsFile,
    results.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  return results;
}
