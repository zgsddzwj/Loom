import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { appendMemory, loadMemory, MEMORY_BUDGET } from "../src/memory/store.js";
import { makeMemoryTool } from "../src/memory/memoryTool.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "loom-mem-")), "memory.md");
}

describe("cross-session memory store", () => {
  it("appends dated fact lines and refuses exact duplicates", () => {
    const file = tmpFile();
    expect(appendMemory("user prefers tabs", file)).toMatch(/OK: saved/);
    expect(appendMemory("user prefers tabs", file)).toMatch(/already in memory/);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toMatch(/- \d{4}-\d{2}-\d{2} user prefers tabs/);
    expect(text.split("\n").filter(Boolean).length).toBe(1);
  });

  it("loads within budget, keeping the newest tail when truncated", () => {
    const file = tmpFile();
    // ~200 chars per fact × 50 = ~10KB > 8192 budget
    for (let i = 0; i < 50; i++) appendMemory(`fact number ${i} ${"x".repeat(200)}`, file);
    const loaded = loadMemory(file);
    expect(loaded.length).toBeLessThanOrEqual(MEMORY_BUDGET + 100);
    expect(loaded).toContain("budget-truncated");
    expect(loaded).toContain("fact number 49"); // newest survives
    expect(loaded).not.toContain("fact number 0"); // oldest dropped
  });

  it("returns empty for a missing file", () => {
    expect(loadMemory(path.join(os.tmpdir(), "loom-no-such-memory.md"))).toBe("");
  });
});

describe("memory tool", () => {
  it("read reports empty; append persists; errors are explicit", async () => {
    const file = tmpFile();
    const tool = makeMemoryTool(file);
    const empty = await tool.execute({ action: "read" });
    expect(empty).toMatch(/memory is empty/);

    expect(await tool.execute({ action: "append", fact: "prefer vitest" })).toMatch(/OK: saved/);
    const read = await tool.execute({ action: "read" });
    expect(read).toContain("prefer vitest");

    await expect(tool.execute({ action: "append" })).rejects.toThrow(/non-empty fact/);
    await expect(tool.execute({ action: "explode" })).rejects.toThrow(/Unknown action/);
  });
});
