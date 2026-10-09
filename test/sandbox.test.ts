import { describe, expect, it } from "vitest";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createSandbox, detectSandbox } from "../src/sandbox/sandbox.js";
import { bashTool } from "../src/tools/bash.js";
import { ArtifactStore } from "../src/context/artifacts.js";
import { ReadState } from "../src/tools/readstate.js";
import type { ToolContext } from "../src/tools/registry.js";

function tmpContext(): { cwd: string; ctx: ToolContext } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-sbx-"));
  const ctx: ToolContext = {
    cwd,
    sessionDir: cwd,
    artifacts: new ArtifactStore(path.join(cwd, "artifacts")),
    readState: new ReadState(),
    jobs: new Map(),
    io: {},
  };
  return { cwd, ctx };
}

describe("OS sandbox", () => {
  it("detects a sandbox kind without throwing", () => {
    const kind = detectSandbox();
    expect(["seatbelt", "bwrap", null]).toContain(kind);
  });

  it.runIf(process.platform === "darwin")(
    "seatbelt: writes inside workspace OK, outside DENIED, network DENIED",
    async () => {
      const { cwd } = tmpContext();
      const sb = createSandbox(cwd, [path.join(cwd, "artifacts")]);
      expect(sb?.kind).toBe("seatbelt");

      const run = (cmd: string) => {
        const wrapped = sb!.wrap(cmd);
        expect(wrapped).toBeTruthy();
        const r = cp.spawnSync("/bin/bash", ["-c", wrapped!], { cwd, encoding: "utf8", timeout: 30_000 });
        return r.status;
      };

      // inside: allowed (also proves the artifacts dir write works)
      expect(run("echo data > artifacts/job.log && echo ok > inside.txt")).toBe(0);
      expect(fs.readFileSync(path.join(cwd, "inside.txt"), "utf8").trim()).toBe("ok");
      expect(fs.readFileSync(path.join(cwd, "artifacts", "job.log"), "utf8").trim()).toBe("data");
      // system reads still work (dependency checkouts, toolchains)
      expect(run("cat /etc/hosts > /dev/null")).toBe(0);
      // outside writes: denied
      const outside = path.join(os.tmpdir(), `loom-sbx-deny-${Date.now()}.txt`);
      expect(run(`echo x > ${JSON.stringify(outside)}`)).not.toBe(0);
      expect(fs.existsSync(outside)).toBe(false);
      // network: denied
      expect(run("curl -s -m 3 http://127.0.0.1:9/")).not.toBe(0);
    },
    120_000,
  );

  it("bash tool refuses to run when the sandbox cannot wrap (fail-closed)", async () => {
    const { ctx } = tmpContext();
    ctx.sandboxWrap = () => null; // sandbox present but wrapping failed
    await expect(bashTool.execute({ command: "echo hi" }, ctx)).rejects.toThrow(/fail-closed/);
  });

  it("bash tool runs the wrapped command when wrapping succeeds", async () => {
    const { ctx } = tmpContext();
    ctx.sandboxWrap = (cmd) => `echo wrap-prefix-once; ${cmd}`;
    const out = await bashTool.execute({ command: "echo hi", timeout_ms: 30_000 }, ctx);
    expect(out).toContain("wrap-prefix-once");
    expect(out).toContain("hi");
  });
});
