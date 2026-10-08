/**
 * Tool-result pre-pruning (inherited from dsh): truncate oversized outputs
 * BEFORE they ever enter the context, spilling the full content to an
 * artifact with a locator. The model can pull it back with `recall`.
 */

import type { ArtifactStore } from "./artifacts.js";

export interface PruneResult {
  content: string;
  locator?: string;
}

export function pruneToolResult(content: string, maxBytes: number, store: ArtifactStore): PruneResult {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return { content };
  const head = content.slice(0, Math.max(0, maxBytes));
  const locator = store.spill("tool-result", content);
  return {
    content:
      `${head}\n\n` +
      `[[Loom: output exceeded ${maxBytes} bytes and was truncated. The full output was preserved — call recall with locator "${locator}" to retrieve it.]]`,
    locator,
  };
}
