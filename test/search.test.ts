import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { globTool, grepTool, globToRegex, walkFiles, grepWithJs } from "../src/tools/search.js";
import { ArtifactStore } from "../src/context/artifacts.js";
import { ReadState } from "../src/tools/readstate.js";
import type { ToolContext } from "../src/tools/registry.js";

let cwd: string;
let ctx: ToolContext;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-search-"));
  fs.mkdirSync(path.join(cwd, "src", "sub"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(cwd, "src", "sub", "b.ts"), "const b: number = 2;\n");
  fs.writeFileSync(path.join(cwd, "pkg.json"), "{}\n");
  fs.writeFileSync(path.join(cwd, "x.txt"), "lorem\n");
  ctx = {
    cwd,
    sessionDir: cwd,
    artifacts: new ArtifactStore(path.join(cwd, "artifacts")),
    readState: new ReadState(),
    jobs: new Map(),
    io: {},
  };
});

describe("globToRegex", () => {
  it("handles **, *, ?, and alternation", () => {
    expect(globToRegex("**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegex("**/*.ts").test("src/sub/b.ts")).toBe(true);
    expect(globToRegex("**/*.ts").test("pkg.json")).toBe(false);
    expect(globToRegex("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegex("src/*.ts").test("src/sub/b.ts")).toBe(false); // * does not cross /
    expect(globToRegex("?.txt").test("x.txt")).toBe(true);
    expect(globToRegex("?.txt").test("xy.txt")).toBe(false);
    expect(globToRegex("{a,b}.ts").test("a.ts")).toBe(true);
    expect(globToRegex("{a,b}.ts").test("c.ts")).toBe(false);
  });
});

describe("glob tool", () => {
  it("finds matching files relative to cwd", async () => {
    const out = await globTool.execute({ pattern: "**/*.ts" }, ctx);
    expect(out).toContain("src/a.ts");
    expect(out).toContain("src/sub/b.ts");
    expect(out).not.toContain("pkg.json");
    expect(out).toMatch(/\[2 file\(s\)\]/);
  });

  it("walk skips node_modules and .git", () => {
    fs.mkdirSync(path.join(cwd, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "node_modules", "pkg", "junk.ts"), "junk\n");
    const files = walkFiles(cwd);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });
});

describe("grep tool", () => {
  it("finds matches with file:line:content", async () => {
    const out = await grepTool.execute({ pattern: "number", glob: "*.ts" }, ctx);
    expect(out).toContain("src/sub/b.ts:1:");
    expect(out).toContain("const b: number = 2;");
  });

  it("reports no matches clearly", async () => {
    const out = await grepTool.execute({ pattern: "zzz-not-there" }, ctx);
    expect(out).toMatch(/No matches/);
  });

  it("supports ignore_case", async () => {
    fs.writeFileSync(path.join(cwd, "case.txt"), "HeLLo World\n");
    const out = await grepTool.execute({ pattern: "hello", ignore_case: true }, ctx);
    expect(out).toContain("HeLLo");
    const none = await grepTool.execute({ pattern: "hello" }, ctx);
    expect(none).toMatch(/No matches/);
  });

  it("pure-JS fallback (grepWithJs) matches regardless of ripgrep presence", () => {
    fs.writeFileSync(path.join(cwd, "case.txt"), "HeLLo World\n");
    // Direct coverage for the fallback path: CI runners may lack ripgrep, and
    // a missing binary must never surface as a silent "No matches".
    const out = grepWithJs("number", cwd, { glob: "*.ts", cwd });
    expect(out).toContain("src/sub/b.ts:1:");
    expect(out).toContain("const b: number = 2;");

    const ci = grepWithJs("hello", cwd, { ignoreCase: true, cwd });
    expect(ci).toContain("HeLLo");
    expect(grepWithJs("hello", cwd, { cwd })).toMatch(/No matches/);
    expect(grepWithJs("zzz-not-there", cwd, { cwd })).toMatch(/No matches/);
  });

  it("grep tool itself must produce matches on this machine (rg or fallback)", async () => {
    // If this fails on a machine WITH ripgrep installed, the rg branch is
    // broken; without ripgrep, hasRg()/fallback handling is broken.
    const out = await grepTool.execute({ pattern: "number", glob: "*.ts" }, ctx);
    expect(out).toContain("const b: number = 2;");
  });
});
