/**
 * Token estimation.
 *
 * Deliberately heuristic (CJK chars count ~1 token each, other text ~4
 * chars/token). Good enough to trigger compaction before a hard context
 * error; exact counting is the provider's job.
 */

import type { ModelRequest, ProjectedMessage, ToolSchema } from "../core/types.js";

export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3000-\u9fff\u3040-\u30ff\uff00-\uffef]/g) || []).length;
  return cjk + Math.ceil(Math.max(0, text.length - cjk) / 4);
}

export function estimateRequestTokens(
  system: string,
  messages: ProjectedMessage[],
  tools: ToolSchema[],
): number {
  let total = estimateTokens(system);
  total += estimateTokens(JSON.stringify(tools));
  total += estimateTokens(JSON.stringify(messages));
  return total;
}

/** Convenience for a full request. */
export function estimateRequest(req: Pick<ModelRequest, "system" | "messages" | "tools">): number {
  return estimateRequestTokens(req.system, req.messages, req.tools);
}
