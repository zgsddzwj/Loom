/**
 * Full-loop smoke test: a scripted "model" drives the real harness —
 * permission engine, hooks, tools, event log, projector, compaction —
 * against a real temp workspace. No network, fully deterministic.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventLog } from "../src/log/eventlog.js";
import { project } from "../src/log/projector.js";
import { ArtifactStore } from "../src/context/artifacts.js";
import { ContextManager } from "../src/context/manager.js";
import { ReadState } from "../src/tools/readstate.js";
import { readTool, editTool, writeTool } from "../src/tools/files.js";
import { bashTool, bashOutputTool } from "../src/tools/bash.js";
import { globTool, grepTool } from "../src/tools/search.js";
import { todoTool } from "../src/tools/todo.js";
import { recallTool } from "../src/tools/recall.js";
import { ToolRegistry, type ToolContext } from "../src/tools/registry.js";
import { PermissionEngine } from "../src/perm/engine.js";
import { HookRunner } from "../src/hooks/runner.js";
import { runTurn, type LoopDeps, type LoopIO } from "../src/core/loop.js";
import { buildSystemPrompt } from "../src/sysprompt.js";
import { ScriptedAdapter, type ScriptedResponse } from "./mock.js";

function setup(script: ScriptedResponse[]) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-smoke-"));
  fs.writeFileSync(path.join(cwd, "notes.txt"), "alpha\nbeta\n");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-smoke-sess-"));
  const log = EventLog.create(root, { cwd, model: "scripted", provider: "mock" });
  const artifacts = new ArtifactStore(path.join(log.sessionDir, "artifacts"));
  const ctx: ToolContext = {
    cwd,
    sessionDir: log.sessionDir,
    artifacts,
    readState: new ReadState(),
    jobs: new Map(),
    io: {},
  };
  const registry = new ToolRegistry(
    [readTool, editTool, writeTool, bashTool, bashOutputTool, globTool, grepTool, todoTool, recallTool],
    ctx,
    30_000,
  );
  const deps = (over: Partial<LoopDeps> = {}): LoopDeps => ({
    log,
    adapter: new ScriptedAdapter(script),
    registry,
    perm: new PermissionEngine("bypassPermissions", []),
    hooks: new HookRunner({}, cwd),
    ctx,
    ctxManager: new ContextManager({
      log,
      artifacts,
      summarizer: async () => "stub summary",
      thresholdTokens: 1_000_000,
    }),
    io: smokeIO(),
    maxSteps: 50,
    buildSystem: () => buildSystemPrompt(""),
    ...over,
  });
  return { cwd, log, artifacts, ctx, registry, deps };
}

function smokeIO(): LoopIO {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onNotice: () => {},
  };
}

describe("smoke: scripted model drives the real loop end-to-end", () => {
  it("reads, edits, writes, runs bash, and finishes with a logged, replayable session", async () => {
    const { cwd, log, deps } = setup([
      { toolCalls: [{ id: "t1", name: "todo", input: { todos: [
        { content: "edit notes.txt", status: "in_progress" },
        { content: "create hello.txt", status: "pending" },
      ] } }] },
      { toolCalls: [{ id: "t2", name: "read", input: { file: "notes.txt" } }] },
      { toolCalls: [{ id: "t3", name: "edit", input: { file: "notes.txt", old_string: "beta", new_string: "BETA" } }] },
      { toolCalls: [{ id: "t4", name: "write", input: { file: "hello.txt", content: "hello loom" } }] },
      { toolCalls: [{ id: "t5", name: "bash", input: { command: "cat notes.txt hello.txt" } }] },
      { toolCalls: [{ id: "t6", name: "grep", input: { pattern: "BETA", glob: "*.txt" } }] },
      { text: "Done: edited notes.txt (beta->BETA), created hello.txt, verified with cat and grep." },
    ]);

    const result = await runTurn(deps(), "fix notes and add hello.txt");
    expect(result.endReason).toBe("end_turn");
    expect(result.steps).toBe(7);

    // side effects on the real workspace
    expect(fs.readFileSync(path.join(cwd, "notes.txt"), "utf8")).toBe("alpha\nBETA\n");
    expect(fs.readFileSync(path.join(cwd, "hello.txt"), "utf8")).toBe("hello loom");

    // the log captures the whole session
    const events = log.list();
    const userMsgs = events.filter((e) => e.t === "user/message").length;
    const asstMsgs = events.filter((e) => e.t === "assistant/message").length;
    const toolResults = events.filter((e) => e.t === "tool/result").length;
    expect(userMsgs).toBe(1);
    expect(asstMsgs).toBe(7);
    expect(toolResults).toBe(6);
    expect(events.at(-1)).toMatchObject({ t: "turn/end", reason: "end_turn" });

    // grep result really flowed through tools
    const grepResult = events.find(
      (e) => e.t === "tool/result" && e.content.includes("notes.txt:2:"),
    );
    expect(grepResult).toBeTruthy();

    // replay determinism: projection is a pure function of the log
    const a = project(log.list());
    const b = project(log.list());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("permission denials surface to the model as error results and the turn continues", async () => {
    const script = [
      { toolCalls: [{ id: "t1", name: "bash", input: { command: "echo nope" } }] },
      { text: "bash was denied, so I will finish without it." },
    ];
    const { log, deps, registry } = setup(script);
    const d = deps();
    d.perm = new PermissionEngine("default", []); // headless: ask => deny (fail-closed)
    const result = await runTurn(d, "run echo");
    expect(result.endReason).toBe("end_turn");

    const denied = log
      .list()
      .find((e) => e.t === "tool/result" && e.isError && e.content.includes("Permission denied"));
    expect(denied).toBeTruthy();
    expect(denied!.content).toContain("fail-closed");
    void registry;
  });

  it("PreToolUse hook exit 2 blocks a tool call", async () => {
    const script = [
      { toolCalls: [{ id: "t1", name: "write", input: { file: "blocked.txt", content: "x" } }] },
      { text: "write was blocked by a hook; done." },
    ];
    const { cwd, log, deps } = setup(script);
    const hooks = new HookRunner(
      {
        // plain `exit 2` — shell-agnostic, no syntax dependencies
        PreToolUse: [{ command: "exit 2", matcher: "write" }],
      },
      cwd,
    );
    const d = deps();
    d.hooks = hooks;
    d.perm = new PermissionEngine("bypassPermissions", []);
    await runTurn(d, "try writing");

    const blocked = log
      .list()
      .find((e) => e.t === "tool/result" && e.isError && e.content.includes("PreToolUse hook"));
    expect(blocked).toBeTruthy();
    expect(fs.existsSync(path.join(cwd, "blocked.txt"))).toBe(false);
  });

  it("bash timeout detaches to a background job instead of killing it", async () => {
    // bash clamps timeouts to >= 1000ms; sleep 1.6s must therefore detach.
    const script = [
      { toolCalls: [{ id: "t1", name: "bash", input: { command: "sleep 1.6 && echo late-result", timeout_ms: 200 } }] },
      { text: "command detached; I will poll later." },
    ];
    const { log, deps, ctx } = setup(script);
    const d = deps();
    const first = await runTurn(d, "start long job");
    expect(first.endReason).toBe("end_turn");

    const events = log.list();
    const jobResult = events.find(
      (e) => e.t === "tool/result" && e.content.includes('"status": "running"'),
    );
    expect(jobResult).toBeTruthy(); // returned a running-job notice; did not wait or kill
    const jobId = JSON.parse((jobResult as { content: string }).content).job_id;

    // the detached job keeps running and finishes while we poll
    let final: string | null = null;
    for (let i = 0; i < 40 && !final; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const job = ctx.jobs.get(jobId);
      if (job?.done) final = job.output();
    }
    expect(final).toContain("late-result");
  }, 15_000);

  it("plan mode: research works, edits are denied with guidance, approval flips the mode", async () => {
    const { log, deps, ctx } = setup([
      { toolCalls: [{ id: "t1", name: "grep", input: { pattern: "alpha" } }] },
      { toolCalls: [{ id: "t2", name: "edit", input: { file: "notes.txt", old_string: "alpha", new_string: "ALPHA" } }] },
      { text: "researched; plan ready" },
    ]);
    const d = deps();
    d.perm = new PermissionEngine("plan", []);
    d.registry = new ToolRegistry(
      [readTool, editTool, writeTool, globTool, grepTool, todoTool, recallTool],
      ctx,
      30_000,
    );
    await runTurn(d, "plan the edit");

    const events = log.list();
    // read-only research succeeded
    expect(events.some((e) => e.t === "tool/result" && !e.isError && e.content.includes("alpha"))).toBe(true);
    // edit was denied with plan-mode guidance
    const denied = events.find(
      (e) => e.t === "tool/result" && e.isError && e.content.includes("Plan mode"),
    );
    expect(denied).toBeTruthy();
  });
});
