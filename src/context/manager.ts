/**
 * Context manager: token estimation + RECALLABLE compaction.
 *
 * Compaction policy:
 * - triggered when the projected request exceeds the threshold;
 * - everything BEFORE the last user/message event is compacted (the current
 *   task segment is kept intact);
 * - the full pre-compaction history is spilled to an artifact (locator);
 * - an LLM summary is produced by a dedicated request whose summarization
 *   instruction is placed at the END of the request (dsh's cache-prefix
 *   trick);
 * - the compaction event enters the log, so the projector replaces the old
 *   prefix with summary + recall hint. Nothing is lost: recall(locator)
 *   brings the verbatim history back.
 */

import type { ModelAdapter, ProjectedMessage, ToolSchema } from "../core/types.js";
import { EventLog, type LoomEvent } from "../log/eventlog.js";
import { project } from "../log/projector.js";
import { ArtifactStore } from "./artifacts.js";
import { estimateRequestTokens } from "./tokens.js";

export type Summarizer = (messages: ProjectedMessage[], maxTokens: number) => Promise<string>;

export interface ContextManagerOptions {
  log: EventLog;
  artifacts: ArtifactStore;
  summarizer: Summarizer;
  thresholdTokens: number;
  summaryMaxTokens?: number;
}

const SUMMARIZER_SYSTEM =
  "You are a summarization engine for a coding agent's session log. Produce a dense, factual " +
  "summary that lets work continue seamlessly. Include: the original task/goals, decisions made " +
  "and their rationale, files created/edited (paths), commands run and their outcomes, open " +
  "questions, and the exact next steps. Prefer bullet lists. Do not editorialize.";

const SUMMARIZER_INSTRUCTION =
  "Summarize the conversation above for continuation. The summary replaces the raw history in " +
  "the model's context, so every load-bearing detail matters: task, decisions, file paths, " +
  "command results, pending steps. Output only the summary.";

export class ContextManager {
  constructor(private opts: ContextManagerOptions) {}

  private lastCompactionSeq(): number {
    const events = this.opts.log.list();
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.t === "compaction") return ev.seq;
    }
    return 0;
  }

  /** Find a compaction split point: the seq of the LAST user/message event. */
  private splitPoint(): number | null {
    const events = this.opts.log.list();
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.t === "user/message" && ev.seq > this.lastCompactionSeq()) return ev.seq;
    }
    return null;
  }

  async maybeCompact(
    system: string,
    messages: ProjectedMessage[],
    tools: ToolSchema[],
  ): Promise<boolean> {
    const est = estimateRequestTokens(system, messages, tools);
    if (est <= this.opts.thresholdTokens) return false;

    const keepSeq = this.splitPoint();
    if (keepSeq === null) return false; // nothing before the current task segment

    const events = this.opts.log.list();
    const preEvents: LoomEvent[] = events.filter(
      (ev) => ev.seq < keepSeq && ev.t !== "session/start",
    );
    if (preEvents.length === 0) return false;

    const pre = project(preEvents);

    // Spill the full verbatim history — compaction is recallable, never lossy.
    const locator = this.opts.artifacts.spill(
      "compaction-full",
      JSON.stringify({ compactedAtEventSeq: keepSeq - 1, messages: pre.messages }, null, 2),
    );

    let summary: string;
    try {
      summary = await this.opts.summarizer(pre.messages, this.opts.summaryMaxTokens ?? 1500);
    } catch (e) {
      summary =
        `(summarization failed: ${(e as Error).message}; the verbatim history is safe and ` +
        `recallable via "${locator}")`;
    }

    this.opts.log.append({
      t: "compaction",
      summary,
      locator,
      upToSeq: keepSeq - 1,
    });
    return true;
  }

  /** Manual /compact command. */
  forceCompact(system: string, messages: ProjectedMessage[], tools: ToolSchema[]): Promise<boolean> {
    return this.maybeCompact(system, messages, tools);
  }
}

/** Production summarizer: a side request through the same adapter. */
export function makeAdapterSummarizer(adapter: ModelAdapter): Summarizer {
  return async (messages, maxTokens) => {
    let text = "";
    const req = {
      system: SUMMARIZER_SYSTEM,
      messages: [...messages, { role: "user" as const, text: SUMMARIZER_INSTRUCTION }],
      tools: [],
      maxTokens,
    };
    for await (const ev of adapter.complete(req)) {
      if (ev.type === "text") text += ev.delta;
    }
    if (!text.trim()) throw new Error("empty summary");
    return text.trim();
  };
}
