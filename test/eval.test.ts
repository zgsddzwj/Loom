import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runEval } from "../src/eval/runner.js";
import { readTool, editTool, writeTool } from "../src/tools/files.js";
import { bashTool, bashOutputTool } from "../src/tools/bash.js";
import { globTool, grepTool } from "../src/tools/search.js";
import { todoTool } from "../src/tools/todo.js";
import { recallTool } from "../src/tools/recall.js";
import { taskTool } from "../src/tools/task.js";
import { ScriptedAdapter } from "./mock.js";

const EVAL_TOOLS = [
  readTool, editTool, writeTool, bashTool, bashOutputTool,
  globTool, grepTool, todoTool, recallTool, taskTool,
];

function buildTasks(root: string): string {
  // NOTE: runEval executes tasks in ALPHABETICAL order — name them so the
  // flat scripted adapter script lines up with execution order.
  // 01: the scripted model writes the right file -> verify passes
  const ok = path.join(root, "01-write-ok");
  fs.mkdirSync(ok, { recursive: true });
  fs.writeFileSync(path.join(ok, "task.md"), "Create hello.txt containing: Hello, Loom!");
  fs.writeFileSync(
    path.join(ok, "verify.sh"),
    `#!/bin/bash\n[ "$(cat hello.txt)" = "Hello, Loom!" ] && echo PASS || { echo "got: $(cat hello.txt 2>/dev/null)"; exit 1; }\n`,
  );
  // 02: the scripted model writes the wrong content -> verify fails
  const bad = path.join(root, "02-write-bad");
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, "task.md"), "Create bye.txt containing: GOODBYE");
  fs.writeFileSync(
    path.join(bad, "verify.sh"),
    `#!/bin/bash\n[ "$(cat bye.txt)" = "GOODBYE" ] && echo PASS || { echo "got: $(cat bye.txt 2>/dev/null)"; exit 1; }\n`,
  );
  return root;
}

describe("loom eval — reproducible benchmark runner", () => {
  it("runs each task in isolation, verifies, and writes results.jsonl", async () => {
    const tasksRoot = buildTasks(fs.mkdtempSync(path.join(os.tmpdir(), "loom-eval-")));
    // one flat script: consumed sequentially across both tasks
    const adapter = new ScriptedAdapter([
      { toolCalls: [{ id: "a1", name: "write", input: { file: "hello.txt", content: "Hello, Loom!" } }] },
      { text: "created hello.txt" },
      { toolCalls: [{ id: "b1", name: "write", input: { file: "bye.txt", content: "wrong content" } }] },
      { text: "created bye.txt (wrong on purpose)" },
    ]);

    const results = await runEval(tasksRoot, {
      adapter,
      allToolDefs: EVAL_TOOLS,
      pruneBytes: 30_000,
      compactThresholdTokens: 1_000_000,
      maxSteps: 10,
    });

    expect(results.length).toBe(2);
    const [ok, bad] = results;
    expect(ok.task).toBe("01-write-ok");
    expect(ok.pass).toBe(true);
    expect(ok.steps).toBe(2);
    expect(ok.inputTokens).toBeGreaterThan(0);
    expect(ok.verifyExit).toBe(0);

    expect(bad.task).toBe("02-write-bad");
    expect(bad.pass).toBe(false);
    expect(bad.verifyExit).not.toBe(0);

    // each task got its own isolated workspace and session
    expect(ok.workspace).not.toBe(bad.workspace);
    expect(ok.sessionDir).not.toBe(bad.sessionDir);
    expect(fs.existsSync(path.join(ok.sessionDir, "log.jsonl"))).toBe(true);
    expect(fs.readFileSync(path.join(ok.workspace, "hello.txt"), "utf8")).toBe("Hello, Loom!");
    expect(fs.readFileSync(path.join(bad.workspace, "bye.txt"), "utf8")).toBe("wrong content");

    // results manifest
    const resultsFile = path.join(tasksRoot, "eval-results.jsonl");
    const lines = fs.readFileSync(resultsFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).task).toBe("01-write-ok");
    expect(JSON.parse(lines[1]).pass).toBe(false);
  });

  it("fails clearly when the tasks dir has no task.md", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "loom-eval-empty-"));
    await expect(
      runEval(empty, { adapter: new ScriptedAdapter([]), allToolDefs: EVAL_TOOLS }),
    ).rejects.toThrow(/No eval tasks/);
  });
});
