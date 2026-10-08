/** Scripted adapter: deterministic responses for testing the full loop. */

import type { ModelAdapter, ModelRequest, StreamEvent, ToolCall } from "../src/index.js";

export interface ScriptedResponse {
  text?: string;
  toolCalls?: ToolCall[];
}

export class ScriptedAdapter implements ModelAdapter {
  model = "scripted";
  calls: ModelRequest[] = [];

  constructor(public script: ScriptedResponse[]) {}

  async *complete(req: ModelRequest): AsyncIterable<StreamEvent> {
    this.calls.push(req);
    const resp = this.script[Math.min(this.i++, this.script.length - 1)];
    if (resp.text) {
      for (const chunk of resp.text.match(/.{1,8}/gs) ?? []) {
        yield { type: "text", delta: chunk };
      }
    }
    for (const tc of resp.toolCalls ?? []) {
      yield { type: "tool_use", id: tc.id, name: tc.name, input: tc.input };
    }
    yield {
      type: "done",
      stopReason: resp.toolCalls?.length ? "tool_use" : "end_turn",
      usage: { input: 100, output: 50 },
    };
  }

  private i = 0;
}
