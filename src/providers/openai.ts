/**
 * OpenAI-compatible adapter (chat/completions + function calling).
 *
 * Works with OpenAI, DeepSeek, Zhipu GLM, Moonshot Kimi, Ollama, LM Studio,
 * vLLM and any other OpenAI-compatible endpoint. reasoning_content deltas
 * (DeepSeek reasoner style) are intentionally not part of model history.
 */

import { randomUUID } from "node:crypto";
import type {
  ModelAdapter,
  ModelRequest,
  ProjectedMessage,
  StreamEvent,
  TokenUsage,
} from "../core/types.js";
import { sseDataLines } from "./sse.js";

export interface OpenAICompatOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens?: number;
}

export class OpenAICompatAdapter implements ModelAdapter {
  readonly model: string;

  constructor(private opts: OpenAICompatOptions) {
    this.model = opts.model;
  }

  async *complete(req: ModelRequest): AsyncIterable<StreamEvent> {
    const messages: Array<Record<string, unknown>> = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      if (m.role === "assistant") {
        const msg: Record<string, unknown> = { role: "assistant", content: m.text ?? "" };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          }));
        }
        messages.push(msg);
      } else {
        for (const r of m.toolResults ?? []) {
          messages.push({ role: "tool", tool_call_id: r.callId, content: r.content });
        }
        if (m.text) messages.push({ role: "user", content: m.text });
      }
    }

    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      stream: true,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    };

    const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      throw new Error(`OpenAI-compatible API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }

    const acc = new Map<number, { id: string; name: string; args: string }>();
    let stopReason = "end_turn";
    let usage: TokenUsage | undefined;

    for await (const data of sseDataLines(res)) {
      if (!data || data === "[DONE]") continue;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.usage) usage = { input: j.usage.prompt_tokens, output: j.usage.completion_tokens };
      const choice = j.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        yield { type: "text", delta: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index ?? 0;
          if (!acc.has(idx)) acc.set(idx, { id: "", name: "", args: "" });
          const e = acc.get(idx)!;
          if (tc.id) e.id = tc.id;
          if (tc.function?.name) e.name = tc.function.name;
          if (tc.function?.arguments) e.args += tc.function.arguments;
        }
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }

    for (const e of acc.values()) {
      let input: Record<string, unknown> = {};
      try {
        input = e.args ? JSON.parse(e.args) : {};
      } catch {
        input = { _raw: e.args };
      }
      yield {
        type: "tool_use",
        id: e.id || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        name: e.name,
        input,
      };
    }
    const mapped =
      stopReason === "tool_calls" ? "tool_use" : stopReason === "length" ? "max_tokens" : "end_turn";
    yield { type: "done", stopReason: mapped, usage };
  }
}

export type { ProjectedMessage };
