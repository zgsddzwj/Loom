import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventLog } from "../src/log/eventlog.js";
import { project } from "../src/log/projector.js";
import { ContextManager } from "../src/context/manager.js";
import { ArtifactStore } from "../src/context/artifacts.js";
import { pruneToolResult } from "../src/context/pruner.js";
import { recallTool } from "../src/tools/recall.js";
import { bashTool } from "../src/tools/bash.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ReadState } from "../src/tools/readstate.js";
import type { ToolContext } from "../src/tools/registry.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-compact-"));
  const log = EventLog.create(root, { cwd: root, model: "mock", provider: "mock" });
  const artifacts = new ArtifactStore(path.join(log.sessionDir, "artifacts"));
  const ctx: ToolContext = {
    cwd: root,
    sessionDir: log.sessionDir,
    artifacts,
    readState: new ReadState(),
    jobs: new Map(),
    io: {},
  };
  return { root, log, artifacts, ctx };
}

describe("pruner + recall (recallable truncation)", () => {
  it("truncates oversized results, spills the full text, and recall restores it", async () => {
    const { artifacts, ctx } = setup();
    const big = "x".repeat(50_000);
    const pruned = pruneToolResult(big, 1000, artifacts);
    expect(pruned.locator).toMatch(/^artifact:/);
    expect(pruned.content.length).toBeLessThan(big.length);
    expect(pruned.content).toContain("recall");

    const restored = await recallTool.execute({ locator: pruned.locator! }, ctx);
    expect(restored).toBe(big);
  });

  it("registry prunes oversized bash output automatically", async () => {
    const { ctx } = setup();
    const registry = new ToolRegistry([bashTool, recallTool], ctx, 500);
    const out = await registry.execute({
      id: "c1",
      name: "bash",
      input: { command: "seq 1 5000" },
    });
    expect(out.isError).toBe(false);
    expect(out.content).toContain("recall");
    expect(out.locator).toMatch(/^artifact:/);
    const full = await recallTool.execute({ locator: out.locator! }, ctx);
    expect(full).toContain("5000");
  });
});

describe("ContextManager — recallable compaction", () => {
  it("compacts everything before the last user/message, spills the verbatim history, and the projector honors it", async () => {
    const { log, artifacts } = setup();
    log.append({ t: "user/message", text: "first task" });
    log.append({ t: "assistant/message", text: "working on it", toolCalls: [], stopReason: "end_turn" });
    log.append({ t: "user/message", text: "second task" });
    log.append({ t: "assistant/message", text: "ok", toolCalls: [], stopReason: "end_turn" });

    const cm = new ContextManager({
      log,
      artifacts,
      summarizer: async () => "SUMMARY-XYZ",
      thresholdTokens: 1, // force compaction
    });

    const before = project(log.list()).messages.length;
    const compacted = await cm.maybeCompact("sys", project(log.list()).messages, []);
    expect(compacted).toBe(true);
    expect(project(log.list()).messages.length).toBeLessThan(before);

    const events = log.list();
    const comp = events.find((e) => e.t === "compaction") as Extract<(typeof events)[number], { t: "compaction" }>;
    expect(comp.summary).toBe("SUMMARY-XYZ");
    // split point: everything before the LAST user message
    const lastUser = [...events].reverse().find((e) => e.t === "user/message")!;
    expect(comp.upToSeq).toBe(lastUser.seq - 1);

    // the verbatim history is spilled and recallable
    const spilled = artifacts.read(comp.locator);
    expect(spilled).toBeTruthy();
    const parsed = JSON.parse(spilled!);
    expect(parsed.messages.length).toBe(2); // "first task" + its answer

    // projection now starts with the summary + recall hint
    const proj = project(log.list());
    expect(proj.compacted).toBe(true);
    expect(proj.messages[0].text).toContain("SUMMARY-XYZ");
    expect(proj.messages[0].text).toContain(comp.locator);
    // and the current task segment survives intact
    expect(proj.messages.some((m) => m.text === "second task")).toBe(true);
  });

  it("does not compact when there is nothing before the current task segment", async () => {
    const { log, artifacts } = setup();
    log.append({ t: "user/message", text: "only task" });
    const cm = new ContextManager({ log, artifacts, summarizer: async () => "S", thresholdTokens: 1 });
    expect(await cm.maybeCompact("sys", project(log.list()).messages, [])).toBe(false);
  });

  it("keeps working across successive compactions (30+ turn survival pattern)", async () => {
    const { log, artifacts } = setup();
    for (let i = 1; i <= 20; i++) {
      log.append({ t: "user/message", text: `task ${i}` });
      log.append({ t: "assistant/message", text: `answer ${i} `.repeat(200), toolCalls: [], stopReason: "end_turn" });
    }
    const cm = new ContextManager({ log, artifacts, summarizer: async () => "S", thresholdTokens: 1 });
    const ok = await cm.maybeCompact("sys", project(log.list()).messages, []);
    expect(ok).toBe(true);
    const proj = project(log.list());
    expect(proj.compacted).toBe(true);
    // only the summary + the kept tail (last user message + its answer)
    expect(proj.messages.length).toBe(3);
  });
});
