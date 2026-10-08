/**
 * Anthropic Messages API adapter (native protocol).
 *
 * The system prompt is marked cache_control: ephemeral so providers can
 * cache the stable prefix; tool schemas are always sent in full (keeping
 * the request layout stable is part of the cache-alignment strategy).
 */

import type {
  ModelAdapter,
  ModelRequest,
  ProjectedMessage,
  StreamEvent,
  TokenUsage,
} from "../core/types.js";
import { sseDataLines } from "./sse.js";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
}

export class AnthropicAdapter implements ModelAdapter {
  readonly model: string;

  constructor(private opts: AnthropicOptions) {
    this.model = opts.model;
  }

  async *complete(req: ModelRequest): AsyncIterable<StreamEvent> {
    const base = this.opts.baseUrl ?? "https://api.anthropic.com";
    const body = {
      model: this.opts.model,
      max_tokens: req.maxTokens ?? this.opts.maxTokens ?? 8192,
      stream: true,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: toAnthropicMessages(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    };
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);

    const tools = new Map<number, { id: string; name: string; json: string }>();
    let stopReason = "end_turn";
    let usage: TokenUsage | undefined;

    for await (const data of sseDataLines(res)) {
      if (!data) continue;
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        tools.set(ev.index, {
          id: ev.content_block.id,
          name: ev.content_block.name,
          json: "",
        });
      } else if (ev.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta" && ev.delta.text) {
          yield { type: "text", delta: ev.delta.text };
        } else if (ev.delta?.type === "input_json_delta" && tools.has(ev.index)) {
          tools.get(ev.index)!.json += ev.delta.partial_json ?? "";
        }
      } else if (ev.type === "message_delta") {
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage) {
          usage = {
            input: ev.usage.input_tokens,
            output: ev.usage.output_tokens,
            cacheRead: ev.usage.cache_read_input_tokens,
            cacheWrite: ev.usage.cache_creation_input_tokens,
          };
        }
      } else if (ev.type === "error") {
        throw new Error(`Anthropic stream error: ${ev.error?.message ?? data}`);
      }
    }

    for (const t of tools.values()) {
      let input: Record<string, unknown> = {};
      try {
        input = t.json ? JSON.parse(t.json) : {};
      } catch {
        input = { _raw: t.json };
      }
      yield { type: "tool_use", id: t.id, name: t.name, input };
    }
    yield { type: "done", stopReason, usage };
  }
}

function toAnthropicMessages(messages: ProjectedMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
    } else {
      if (m.toolResults?.length) {
        out.push({
          role: "user",
          content: m.toolResults.map((r) => ({
            type: "tool_result",
            tool_use_id: r.callId,
            content: r.content,
            is_error: r.isError ?? false,
          })),
        });
      }
      if (m.text) out.push({ role: "user", content: [{ type: "text", text: m.text }] });
    }
  }
  return out;
}
