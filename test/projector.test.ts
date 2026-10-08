import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventLog } from "../src/log/eventlog.js";
import { project, compactionIntro } from "../src/log/projector.js";

function mkLog(): { log: EventLog; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-proj-"));
  const log = EventLog.create(root, { cwd: "/tmp", model: "m", provider: "openai" });
  return { log, root };
}

describe("projector (pure function: log -> model-visible messages)", () => {
  it("derives user/assistant messages and groups consecutive tool results", () => {
    const { log } = mkLog();
    log.append({ t: "user/message", text: "do it" });
    log.append({
      t: "assistant/message",
      text: "on it",
      toolCalls: [
        { id: "c1", name: "read", input: { file: "a" } },
        { id: "c2", name: "bash", input: { command: "ls" } },
      ],
      stopReason: "tool_use",
    });
    log.append({ t: "tool/result", callId: "c1", content: "content-a" });
    log.append({ t: "tool/result", callId: "c2", content: "content-b", isError: true });
    log.append({ t: "assistant/message", text: "done", toolCalls: [], stopReason: "end_turn" });

    const proj = project(log.list());
    expect(proj.messages.length).toBe(4);
    expect(proj.messages[0]).toEqual({ role: "user", text: "do it" });
    expect(proj.messages[1]).toMatchObject({ role: "assistant", text: "on it" });
    expect(proj.messages[1].toolCalls?.length).toBe(2);
    // consecutive tool results group into a single user message
    expect(proj.messages[2]).toEqual({
      role: "user",
      toolResults: [
        { callId: "c1", content: "content-a", isError: undefined },
        { callId: "c2", content: "content-b", isError: true },
      ],
    });
    expect(proj.messages[3]).toEqual({ role: "assistant", text: "done", toolCalls: undefined });
  });

  it("compaction resets the projection to summary + recall hint", () => {
    const { log } = mkLog();
    log.append({ t: "user/message", text: "old task" });
    log.append({ t: "assistant/message", text: "old answer", toolCalls: [], stopReason: "end_turn" });
    const upTo = log.list()[log.list().length - 1].seq;
    log.append({ t: "compaction", summary: "SUMMARY-X", locator: "artifact:foo.json", upToSeq: upTo });
    log.append({ t: "user/message", text: "new task" });

    const proj = project(log.list());
    expect(proj.compacted).toBe(true);
    expect(proj.messages.length).toBe(2);
    expect(proj.messages[0]).toEqual({
      role: "user",
      text: compactionIntro("SUMMARY-X", "artifact:foo.json"),
    });
    expect(proj.messages[1]).toEqual({ role: "user", text: "new task" });
  });

  it("is deterministic: identical events always project identically", () => {
    const { log } = mkLog();
    log.append({ t: "user/message", text: "task" });
    log.append({
      t: "assistant/message",
      text: "ok",
      toolCalls: [{ id: "c1", name: "bash", input: { command: "echo hi" } }],
      stopReason: "tool_use",
    });
    log.append({ t: "tool/result", callId: "c1", content: "hi" });
    log.append({ t: "assistant/message", text: "fin", toolCalls: [], stopReason: "end_turn" });
    log.append({ t: "compaction", summary: "S", locator: "artifact:l.json", upToSeq: 2 });
    log.append({ t: "user/message", text: "post-compact" });

    const a = project(log.list());
    const b = project(log.list());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
