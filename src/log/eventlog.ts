/**
 * Append-only session event log — the single source of truth.
 *
 * Principle (inherited from DeepSeek Harness): "Model-visible means logged.
 * Every model request must be reconstructable from the log."
 *
 * The file is JSONL, append-only, never rewritten. fork copies the file;
 * resume reopens and appends. Messages are *derived* from events by the
 * projector, so any moment the model-visible context can be rebuilt
 * byte-for-byte from this log alone.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolCall, TokenUsage } from "../core/types.js";

export interface SessionStartEvent {
  t: "session/start";
  seq: number;
  ts: string;
  sessionId: string;
  cwd: string;
  model: string;
  provider: string;
  version: string;
}
export interface TurnStartEvent {
  t: "turn/start";
  seq: number;
  ts: string;
  source: "user" | "resume" | "goal";
}
export interface UserMessageEvent {
  t: "user/message";
  seq: number;
  ts: string;
  text: string;
}
export interface ContextMessageEvent {
  t: "context/message";
  seq: number;
  ts: string;
  kind: "injected" | "compaction-summary" | "system-notice";
  text: string;
}
export interface AssistantMessageEvent {
  t: "assistant/message";
  seq: number;
  ts: string;
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  usage?: TokenUsage;
}
export interface ToolResultEvent {
  t: "tool/result";
  seq: number;
  ts: string;
  callId: string;
  content: string;
  isError?: boolean;
  locator?: string;
}
export interface CompactionEvent {
  t: "compaction";
  seq: number;
  ts: string;
  summary: string;
  locator: string;
  upToSeq: number;
}
export interface TurnEndEvent {
  t: "turn/end";
  seq: number;
  ts: string;
  reason: string;
}

export type LoomEvent =
  | SessionStartEvent
  | TurnStartEvent
  | UserMessageEvent
  | ContextMessageEvent
  | AssistantMessageEvent
  | ToolResultEvent
  | CompactionEvent
  | TurnEndEvent;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event without its assigned fields (seq/ts are set by the log itself). */
export type LoomEventInput = DistributiveOmit<LoomEvent, "seq" | "ts">;

export const LOOM_VERSION = "0.1.0";

/** Module-level counter keeps ids monotonic within a process (time-sortable names). */
let sessionCounter = 0;

export class EventLog {
  private events: LoomEvent[] = [];
  private seq = 0;

  private constructor(readonly sessionDir: string, readonly file: string) {}

  /** Create a new session directory and its first event. */
  static create(
    sessionsRoot: string,
    meta: { cwd: string; model: string; provider: string },
  ): EventLog {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("");
    const clock =
      [
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
      ].join("") + String(now.getMilliseconds()).padStart(3, "0");
    const sessionId = `sess_${stamp}-${clock}-${String(++sessionCounter).padStart(3, "0")}`;
    const sessionDir = path.join(sessionsRoot, sessionId);
    fs.mkdirSync(path.join(sessionDir, "artifacts"), { recursive: true });
    const log = new EventLog(sessionDir, path.join(sessionDir, "log.jsonl"));
    log.append({
      t: "session/start",
      sessionId,
      cwd: meta.cwd,
      model: meta.model,
      provider: meta.provider,
      version: LOOM_VERSION,
    });
    return log;
  }

  /** Reopen an existing session and continue appending. */
  static open(sessionDir: string): EventLog {
    const file = path.join(sessionDir, "log.jsonl");
    if (!fs.existsSync(file)) throw new Error(`No session log at ${file}`);
    const events: LoomEvent[] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line) as LoomEvent);
    }
    const log = new EventLog(sessionDir, file);
    log.events = events;
    log.seq = events.length ? events[events.length - 1].seq : 0;
    return log;
  }

  /** List existing session dirs, newest first. */
  static listSessions(sessionsRoot: string): string[] {
    if (!fs.existsSync(sessionsRoot)) return [];
    return fs
      .readdirSync(sessionsRoot)
      .filter((n) => n.startsWith("sess_"))
      .map((n) => path.join(sessionsRoot, n))
      .filter((p) => fs.existsSync(path.join(p, "log.jsonl")))
      .sort()
      .reverse();
  }

  /** Fork: copy the current log into a new session dir; both stay append-only. */
  fork(sessionsRoot: string): EventLog {
    const forked = EventLog.create(sessionsRoot, {
      cwd: this.cwd,
      model: this.model,
      provider: this.provider,
    });
    for (const ev of this.events) {
      if (ev.t === "session/start") continue;
      const { t, seq: _s, ts: _t, ...rest } = ev as never as Record<string, unknown>;
      forked.append({ t, ...rest } as LoomEventInput);
    }
    return forked;
  }

  get sessionId(): string {
    const first = this.events[0];
    return first && first.t === "session/start" ? first.sessionId : path.basename(this.sessionDir);
  }
  get cwd(): string {
    const first = this.events[0];
    return first && first.t === "session/start" ? first.cwd : process.cwd();
  }
  get model(): string {
    const first = this.events[0];
    return first && first.t === "session/start" ? first.model : "unknown";
  }
  get provider(): string {
    const first = this.events[0];
    return first && first.t === "session/start" ? first.provider : "unknown";
  }

  append(ev: LoomEventInput): LoomEvent {
    const full = { ...ev, seq: ++this.seq, ts: new Date().toISOString() } as LoomEvent;
    fs.appendFileSync(this.file, JSON.stringify(full) + "\n");
    this.events.push(full);
    return full;
  }

  list(): readonly LoomEvent[] {
    return this.events;
  }
}
