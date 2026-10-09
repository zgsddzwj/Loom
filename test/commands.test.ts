import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseCommandFile, discoverCommands, expandCommand, type SlashCommand } from "../src/commands/loader.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-cmd-"));
}

function writeCmd(dir: string, name: string, body: string, description?: string) {
  fs.mkdirSync(dir, { recursive: true });
  const front = description ? `---\ndescription: ${description}\n---\n\n` : "";
  fs.writeFileSync(path.join(dir, `${name}.md`), front + body);
}

describe("slash commands", () => {
  it("parses files with and without frontmatter", () => {
    const dir = tmpdir();
    writeCmd(dir, "review", "Review $ARGUMENTS carefully.", "code review");
    writeCmd(dir, "raw", "Just do it");
    const withFm = parseCommandFile(path.join(dir, "review.md"), "user")!;
    expect(withFm.description).toBe("code review");
    expect(withFm.body).toBe("Review $ARGUMENTS carefully.");
    const raw = parseCommandFile(path.join(dir, "raw.md"), "user")!;
    expect(raw.description).toBe("(no description)");
    expect(raw.body).toBe("Just do it");
  });

  it("expands $ARGUMENTS", () => {
    const cmd: SlashCommand = { name: "x", description: "d", body: "Run with $ARGUMENTS and $ARGUMENTS again", source: "user" };
    expect(expandCommand(cmd, "foo bar")).toBe("Run with foo bar and foo bar again");
  });

  it("priority: project > user > plugin on name collisions", () => {
    const cwd = tmpdir();
    const userRoot = tmpdir();
    writeCmd(userRoot, "shared", "user version", "u");
    writeCmd(path.join(cwd, ".loom", "commands"), "shared", "PROJECT version", "p");
    const pluginCmd: SlashCommand = {
      name: "shared",
      description: "plugin",
      body: "plugin version",
      source: "plugin:test",
    };
    const pluginOnly: SlashCommand = { name: "extra", description: "plugin extra", body: "extra", source: "plugin:test" };

    const cmds = discoverCommands(cwd, [pluginCmd, pluginOnly], userRoot);
    expect(cmds.find((c) => c.name === "shared")!.body).toBe("PROJECT version");
    expect(cmds.find((c) => c.name === "extra")!.body).toBe("extra");
  });
});
