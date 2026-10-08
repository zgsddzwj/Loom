import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readTool, editTool, writeTool } from "../src/tools/files.js";
import { ReadState } from "../src/tools/readstate.js";
import { ArtifactStore } from "../src/context/artifacts.js";
import type { ToolContext } from "../src/tools/registry.js";

let cwd: string;
let readState: ReadState;
let ctx: ToolContext;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-edit-"));
  readState = new ReadState();
  ctx = {
    cwd,
    sessionDir: cwd,
    artifacts: new ArtifactStore(path.join(cwd, "artifacts")),
    readState,
    jobs: new Map(),
    io: {},
  };
});

describe("read tool", () => {
  it("returns line-numbered content and records read state", async () => {
    fs.writeFileSync(path.join(cwd, "a.txt"), "alpha\nbeta\n");
    const out = await readTool.execute({ file: "a.txt" }, ctx);
    expect(out).toContain("1\u2192alpha");
    expect(out).toContain("2\u2192beta");
    expect(readState.has(path.join(cwd, "a.txt"))).toBe(true);
  });

  it("refuses to read directories with a helpful pointer", async () => {
    await expect(readTool.execute({ file: "." }, ctx)).rejects.toThrow(/directory/i);
  });
});

describe("edit tool — mechanically enforced discipline", () => {
  it("refuses to edit a file that was not read (blind edit blocked)", async () => {
    fs.writeFileSync(path.join(cwd, "a.txt"), "alpha\n");
    await expect(
      editTool.execute({ file: "a.txt", old_string: "alpha", new_string: "ALPHA" }, ctx),
    ).rejects.toThrow(/has not been read/);
  });

  it("refuses when the file changed on disk since the last read", async () => {
    const p = path.join(cwd, "a.txt");
    fs.writeFileSync(p, "alpha\n");
    await readTool.execute({ file: "a.txt" }, ctx);
    fs.writeFileSync(p, "alpha-changed-externally\n");
    await expect(
      editTool.execute({ file: "a.txt", old_string: "alpha", new_string: "ALPHA" }, ctx),
    ).rejects.toThrow(/changed on disk/);
  });

  it("replaces a unique match; refuses ambiguous matches without replace_all", async () => {
    const p = path.join(cwd, "dup.txt");
    fs.writeFileSync(p, "x = 1\ny = 1\n");
    await readTool.execute({ file: "dup.txt" }, ctx);

    await expect(
      editTool.execute({ file: "dup.txt", old_string: "1", new_string: "2" }, ctx),
    ).rejects.toThrow(/not unique \(2 occurrences/);

    await editTool.execute({ file: "dup.txt", old_string: "1", new_string: "2", replace_all: true }, ctx);
    expect(fs.readFileSync(p, "utf8")).toBe("x = 2\ny = 2\n");
  });

  it("reports a clear error when old_string is absent", async () => {
    fs.writeFileSync(path.join(cwd, "b.txt"), "one two\n");
    await readTool.execute({ file: "b.txt" }, ctx);
    await expect(
      editTool.execute({ file: "b.txt", old_string: "three", new_string: "3" }, ctx),
    ).rejects.toThrow(/old_string not found/);
  });
});

describe("write tool", () => {
  it("creates new files without requiring a read", async () => {
    const out = await writeTool.execute({ file: "new/dir/file.txt", content: "hello" }, ctx);
    expect(out).toMatch(/OK: wrote 5 bytes/);
    expect(fs.readFileSync(path.join(cwd, "new/dir/file.txt"), "utf8")).toBe("hello");
  });

  it("refuses to overwrite an existing file that was never read", async () => {
    fs.writeFileSync(path.join(cwd, "exists.txt"), "old content");
    await expect(
      writeTool.execute({ file: "exists.txt", content: "new content" }, ctx),
    ).rejects.toThrow(/has not been read/);
  });

  it("overwrites after a read", async () => {
    fs.writeFileSync(path.join(cwd, "exists.txt"), "old content");
    await readTool.execute({ file: "exists.txt" }, ctx);
    await writeTool.execute({ file: "exists.txt", content: "new content" }, ctx);
    expect(fs.readFileSync(path.join(cwd, "exists.txt"), "utf8")).toBe("new content");
  });
});
