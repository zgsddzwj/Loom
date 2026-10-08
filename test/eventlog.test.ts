import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventLog } from "../src/log/eventlog.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-test-"));
}

describe("EventLog (append-only single source of truth)", () => {
  it("creates a session, persists events, and reopens for resume", () => {
    const root = tmpRoot();
    const log = EventLog.create(root, { cwd: "/tmp", model: "m", provider: "openai" });
    expect(log.sessionId).toMatch(/^sess_\d{8}-\d{9}-/);
    log.append({ t: "user/message", text: "hello" });
    log.append({ t: "assistant/message", text: "hi", toolCalls: [], stopReason: "end_turn" });

    const reopened = EventLog.open(log.sessionDir);
    expect(reopened.list().length).toBe(3);
    expect(reopened.list()[1]).toMatchObject({ t: "user/message", text: "hello", seq: 2 });
    expect(reopened.sessionId).toBe(log.sessionId);

    reopened.append({ t: "user/message", text: "again" });
    expect(reopened.list().length).toBe(4);
    expect(reopened.list()[3].seq).toBe(4);
    // original in-memory copy untouched
    expect(log.list().length).toBe(3);
  });

  it("fork preserves the full history and diverges afterwards", () => {
    const root = tmpRoot();
    const log = EventLog.create(root, { cwd: "/tmp", model: "m", provider: "openai" });
    log.append({ t: "user/message", text: "A" });
    log.append({ t: "assistant/message", text: "B", toolCalls: [], stopReason: "end_turn" });

    const forked = log.fork(root);
    expect(forked.sessionId).not.toBe(log.sessionId);
    // fork carries both historical events
    const texts = forked
      .list()
      .filter((e) => e.t === "user/message" || e.t === "assistant/message")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["A", "B"]);

    forked.append({ t: "user/message", text: "C" });
    expect(log.list().length).toBe(3);
    expect(forked.list().length).toBe(4);
  });

  it("lists sessions newest-first", () => {
    const root = tmpRoot();
    EventLog.create(root, { cwd: "/tmp", model: "m", provider: "openai" });
    const second = EventLog.create(root, { cwd: "/tmp", model: "m", provider: "openai" });
    const sessions = EventLog.listSessions(root);
    expect(sessions.length).toBe(2);
    expect(path.basename(sessions[0])).toBe(path.basename(second.sessionDir));
  });
});
