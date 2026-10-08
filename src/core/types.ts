/**
 * Loom core types — the normalized internal message format.
 *
 * Everything the model sees is derived from the append-only event log by the
 * projector; providers adapt between this format and their wire protocols
 * (Anthropic Messages / OpenAI-compatible chat completions).
 */

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError?: boolean;
}

export interface ProjectedMessage {
  role: "user" | "assistant";
  text?: string;
  /** assistant message tool calls */
  toolCalls?: ToolCall[];
  /** user message carrying tool results (grouped) */
  toolResults?: ToolResult[];
}

export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | string;

export interface ModelRequest {
  system: string;
  messages: ProjectedMessage[];
  tools: ToolSchema[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "done"; stopReason: StopReason; usage?: TokenUsage };

export interface ModelAdapter {
  model: string;
  complete(req: ModelRequest): AsyncIterable<StreamEvent>;
}
