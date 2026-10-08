import { describe, expect, it } from "vitest";
import {
  PermissionEngine,
  parseRuleSpec,
  type PermRule,
} from "../src/perm/engine.js";

const READ = { name: "read", readonly: true };
const EDIT = { name: "edit", readonly: false };
const BASH = { name: "bash", readonly: false };

describe("rule parsing", () => {
  it("parses Bash(git push:*) specs", () => {
    expect(parseRuleSpec("Bash(git push:*)", "deny")).toEqual({
      tool: "Bash",
      pattern: "git push:*",
      effect: "deny",
    });
    expect(parseRuleSpec("Edit", "allow")).toEqual({ tool: "Edit", pattern: undefined, effect: "allow" });
  });
});

describe("permission engine — client-enforced decisions", () => {
  it("deny rule with :* prefix matching beats everything", async () => {
    const perm = new PermissionEngine(
      "default",
      [
        parseRuleSpec("Bash(git push:*)", "deny"),
        parseRuleSpec("Bash", "allow"),
      ],
      { ask: async () => true },
    );
    const d = await perm.check(BASH, { command: "git push origin main" });
    expect(d.effect).toBe("deny");
    expect(d.reason).toContain("permission rule");
    // other bash commands fall through to the allow rule
    const d2 = await perm.check(BASH, { command: "ls -la" });
    expect(d2.effect).toBe("allow");
  });

  it("exact-match rules", async () => {
    const perm = new PermissionEngine("default", [parseRuleSpec("Edit(.env)", "ask")], {
      ask: async () => true,
    });
    expect((await perm.check(EDIT, { file: ".env" })).asked).toBe(true);
    expect((await perm.check(EDIT, { file: "src/index.ts" })).asked).toBe(true); // falls to mode default: ask
  });

  it("mode default asks for non-readonly tools; acceptEdits auto-allows edits", async () => {
    let asked = 0;
    const def = new PermissionEngine("default", [], { ask: async () => { asked++; return true; } });
    expect((await def.check(READ, { file: "a" })).effect).toBe("allow"); // readonly free
    expect((await def.check(EDIT, { file: "a", old_string: "x", new_string: "y" })).effect).toBe("allow");
    expect(asked).toBe(1);

    const ae = new PermissionEngine("acceptEdits", [], { ask: async () => true });
    expect((await ae.check(EDIT, { file: "a" })).effect).toBe("allow"); // no ask
    expect((await ae.check(BASH, { command: "ls" })).asked).toBe(true); // bash still asks
  });

  it("plan mode allows only read-only tools", async () => {
    const perm = new PermissionEngine("plan", [], { ask: async () => true });
    expect((await perm.check(READ, { file: "a" })).effect).toBe("allow");
    const d = await perm.check(EDIT, { file: "a" });
    expect(d.effect).toBe("deny");
    expect(d.reason).toContain("Plan mode");
    expect((await perm.check(BASH, { command: "ls" })).effect).toBe("deny");
    // the plan gate itself is readonly and therefore allowed
    expect((await perm.check({ name: "exit_plan", readonly: true }, { plan: "x" })).effect).toBe("allow");
  });

  it("fail-closed: headless sessions turn asks into denies", async () => {
    const perm = new PermissionEngine("default", []);
    const d = await perm.check(BASH, { command: "cargo test" });
    expect(d.effect).toBe("deny");
    expect(d.reason).toContain("fail-closed");
  });

  it("user rejection is a deny", async () => {
    const perm = new PermissionEngine("default", [], { ask: async () => false });
    expect((await perm.check(BASH, { command: "rm file" })).effect).toBe("deny");
  });

  it("bypassPermissions allows everything (sandbox-only mode)", async () => {
    const perm = new PermissionEngine("bypassPermissions", []);
    expect((await perm.check(BASH, { command: "anything" })).effect).toBe("allow");
  });
});
