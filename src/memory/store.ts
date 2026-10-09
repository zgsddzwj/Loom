/**
 * Cross-session memory — a CORE-owned capability, deliberately NOT a plugin.
 * This answers dsh's biggest organizational flaw: "everything is a plugin
 * means memory is nobody's problem". Loom gives memory an owner.
 *
 * Design: one curated file, ~/.loom/memory.md.
 * - loaded (budget-capped, newest last) into the system prompt at start;
 * - appended via the `memory` tool (model writes durable facts);
 * - user can edit the file directly; it is plain markdown.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MEMORY_BUDGET = 8192;

export function memoryFile(): string {
  return path.join(os.homedir(), ".loom", "memory.md");
}

/** Newest-last projection within the budget: keeps the tail (most recent). */
export function loadMemory(file = memoryFile()): string {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (!text) return "";
    if (text.length <= MEMORY_BUDGET) return text;
    const cut = text.slice(text.length - MEMORY_BUDGET);
    const firstNewline = cut.indexOf("\n");
    return "[[older memory entries were budget-truncated]]\n" + cut.slice(firstNewline + 1);
  } catch {
    return "";
  }
}

export function appendMemory(fact: string, file = memoryFile()): string {
  const line = `- ${new Date().toISOString().slice(0, 10)} ${fact.trim().replace(/\s+/g, " ")}`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (existing.includes(line)) return "OK: already in memory (no duplicate written).";
  const next = existing ? `${existing.replace(/\n+$/, "")}\n${line}\n` : `${line}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, "utf8");
  return `OK: saved to cross-session memory (${next.length} bytes total; injected into future sessions).`;
}
