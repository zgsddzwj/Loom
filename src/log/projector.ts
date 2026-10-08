/**
 * Projector: log events -> model-visible messages.
 *
 * A PURE function of the event list. The same log always projects to the
 * same context, byte for byte — this is what makes sessions replayable and
 * debuggable (`loom replay`).
 *
 * Compaction events carry upToSeq: only messages derived from events at or
 * before that point are replaced by the summary. The kept tail (the current
 * task segment, derived from events after upToSeq) survives intact, because
 * the compaction event is appended at the END of the log even though it
 * logically splits the middle. Each projected message tracks the seq of the
 * newest event it derived from, which is what makes this selective reset
 * possible.
 */

import type { LoomEvent } from "./eventlog.js";
import type { ProjectedMessage, ToolResult } from "../core/types.js";

export interface Projection {
  messages: ProjectedMessage[];
  compacted: boolean;
}

export function compactionIntro(summary: string, locator: string): string {
  return (
    `[Context notice: earlier conversation was compacted to save context window. Summary of what happened so far:]\n\n` +
    `${summary}\n\n` +
    `[The full compacted history is preserved outside the context window. To retrieve any part of it verbatim, call the recall tool with locator "${locator}".]`
  );
}

export function project(events: readonly LoomEvent[]): Projection {
  const out: Array<{ msg: ProjectedMessage; seq: number }> = [];
  let pending: Array<{ result: ToolResult; seq: number }> = [];
  let compacted = false;

  const flushToolResults = (uptoSeq: number) => {
    if (pending.length > 0) {
      out.push({
        msg: { role: "user", toolResults: pending.map((p) => p.result) },
        seq: uptoSeq,
      });
      pending = [];
    }
  };

  for (const ev of events) {
    switch (ev.t) {
      case "session/start":
      case "turn/start":
      case "turn/end":
        break;
      case "user/message":
      case "context/message":
        flushToolResults(ev.seq);
        out.push({ msg: { role: "user", text: ev.text }, seq: ev.seq });
        break;
      case "assistant/message":
        flushToolResults(ev.seq);
        out.push({
          msg: {
            role: "assistant",
            text: ev.text || undefined,
            toolCalls: ev.toolCalls.length > 0 ? ev.toolCalls : undefined,
          },
          seq: ev.seq,
        });
        break;
      case "tool/result":
        pending.push({
          result: { callId: ev.callId, content: ev.content, isError: ev.isError },
          seq: ev.seq,
        });
        break;
      case "compaction": {
        flushToolResults(ev.seq);
        // Selective reset: only messages derived from events <= upToSeq are
        // replaced; the kept tail (seq > upToSeq) is preserved in order.
        const kept = out.filter((t) => t.seq > ev.upToSeq);
        const rebuilt: Array<{ msg: ProjectedMessage; seq: number }> = [
          { msg: { role: "user", text: compactionIntro(ev.summary, ev.locator) }, seq: ev.seq },
          ...kept,
        ];
        out.length = 0;
        out.push(...rebuilt);
        compacted = true;
        break;
      }
    }
  }
  const lastSeq = events.length ? events[events.length - 1].seq : 0;
  flushToolResults(lastSeq);
  return { messages: out.map((t) => t.msg), compacted };
}
