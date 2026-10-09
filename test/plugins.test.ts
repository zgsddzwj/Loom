import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverPlugins, loadPlugin, loadAllPlugins } from "../src/plugins/loader.js";
import { checkTrust, trust, untrust, fingerprintDir } from "../src/plugins/trust.js";

function buildPlugin(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "skills", "deploy"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name, version: "1.0.0", description: "test plugin" }));
  fs.writeFileSync(
    path.join(dir, "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: ship things\n---\n\nship the app",
  );
  fs.mkdirSync(path.join(dir, "commands"), { recursive: true });
  fs.writeFileSync(path.join(dir, "commands", "ship.md"), "---\ndescription: ship it\n---\n\nShip $ARGUMENTS now.");
  fs.writeFileSync(
    path.join(dir, "hooks.json"),
    JSON.stringify({ PreToolUse: [{ matcher: "bash", command: "exit 0" }] }),
  );
  return dir;
}

function setup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-plug-"));
  const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-plug-user-"));
  const storeFile = path.join(cwd, "trust.json");
  return { cwd, userRoot, storeFile };
}

describe("plugin fingerprint trust gate (fail-closed)", () => {
  it("fingerprint is stable and content-sensitive", () => {
    const { userRoot } = setup();
    const dir = buildPlugin(userRoot, "p1");
    const a = fingerprintDir(dir);
    expect(fingerprintDir(dir)).toBe(a);
    fs.appendFileSync(path.join(dir, "plugin.json"), "\n");
    expect(fingerprintDir(dir)).not.toBe(a);
  });

  it("untrusted plugins are skipped with a warning; trusted ones load fully", () => {
    const { cwd, userRoot, storeFile } = setup();
    buildPlugin(userRoot, "p1");
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);

    let [plugin] = loadAllPlugins(cwd, warn, userRoot, storeFile);
    expect(plugin.status).toBe("untrusted");
    expect(plugin.skills.length).toBe(0);
    expect(warnings.join(" ")).toMatch(/NOT trusted.*loom plugin trust p1/);

    trust("user", "p1", path.join(userRoot, "p1"), storeFile);
    [plugin] = loadAllPlugins(cwd, warn, userRoot, storeFile);
    expect(plugin.status).toBe("trusted");
    expect(plugin.skills[0].name).toBe("deploy");
    expect(plugin.commands[0].name).toBe("ship");
    expect(plugin.hooks.PreToolUse?.[0].matcher).toBe("bash");
  });

  it("tampering with a trusted plugin disables it until re-trusted", () => {
    const { cwd, userRoot, storeFile } = setup();
    const dir = buildPlugin(userRoot, "p2");
    trust("user", "p2", dir, storeFile);
    fs.appendFileSync(path.join(dir, "skills", "deploy", "SKILL.md"), "\nsneaky change");
    const warnings: string[] = [];
    const [plugin] = loadAllPlugins(cwd, (m) => warnings.push(m), userRoot, storeFile);
    expect(plugin.status).toBe("changed");
    expect(plugin.skills.length).toBe(0);
    expect(warnings.join(" ")).toMatch(/CHANGED/);

    // re-trust after review brings it back
    trust("user", "p2", dir, storeFile);
    const [again] = loadAllPlugins(cwd, () => {}, userRoot, storeFile);
    expect(again.status).toBe("trusted");
    expect(again.skills.length).toBe(1);

    expect(untrust("user", "p2", storeFile)).toBe(true);
    expect(checkTrust("user", "p2", dir, storeFile).status).toBe("untrusted");
  });

  it("project-scope plugins are discovered too", () => {
    const { cwd, userRoot, storeFile } = setup();
    buildPlugin(path.join(cwd, ".loom", "plugins"), "local");
    const plugins = discoverPlugins(cwd, userRoot);
    expect(plugins.map((p) => `${p.source}/${p.name}`)).toEqual(["project/local"]);
    trust("project", "local", plugins[0].dir, storeFile);
    const [loaded] = loadAllPlugins(cwd, () => {}, userRoot, storeFile);
    expect(loaded.status).toBe("trusted");
    void loadPlugin;
  });
});
