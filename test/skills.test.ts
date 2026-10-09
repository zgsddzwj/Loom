import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverSkills, skillsCatalog } from "../src/skills/loader.js";
import { makeSkillTool } from "../src/skills/skillTool.js";

function setup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-skills-"));
  const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-skills-user-"));
  const mkSkill = (root: string, name: string, description: string, body: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`);
  };
  return { cwd, userRoot, mkSkill };
}

describe("skills: progressive disclosure", () => {
  it("discovers user and project skills; project shadows user by name", () => {
    const { cwd, userRoot, mkSkill } = setup();
    mkSkill(userRoot, "deploy", "user-level deploy skill", "user body");
    mkSkill(userRoot, "review", "user-level review skill", "user body");
    mkSkill(path.join(cwd, ".loom", "skills"), "deploy", "PROJECT deploy skill", "project body");

    const skills = discoverSkills(cwd, userRoot);
    expect(skills.length).toBe(2);
    const deploy = skills.find((s) => s.name === "deploy")!;
    expect(deploy.description).toBe("PROJECT deploy skill");
    expect(deploy.source).toBe("project");
    expect(skills.find((s) => s.name === "review")!.source).toBe("user");
  });

  it("skips skills with missing/oversized descriptions", () => {
    const { cwd, userRoot } = setup();
    const root = path.join(cwd, ".loom", "skills");
    fs.mkdirSync(path.join(root, "broken"), { recursive: true });
    fs.writeFileSync(path.join(root, "broken", "SKILL.md"), "---\nname: broken\n---\nbody");
    fs.mkdirSync(path.join(root, "wordy"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "wordy", "SKILL.md"),
      `---\nname: wordy\ndescription: ${"x".repeat(1100)}\n---\nbody`,
    );
    expect(discoverSkills(cwd, userRoot).length).toBe(0);
  });

  it("catalog contains names+descriptions but never bodies; skill tool loads body on demand", async () => {
    const { cwd, userRoot, mkSkill } = setup();
    mkSkill(userRoot, "deploy", "deploys the app safely", "SHOULDNOTBERESIDENT");
    const skills = discoverSkills(cwd, userRoot);
    const catalog = skillsCatalog(skills);
    expect(catalog).toContain("deploy");
    expect(catalog).toContain("deploys the app safely");
    expect(catalog).not.toContain("SHOULDNOTBERESIDENT");

    const tool = makeSkillTool(skills);
    const body = await tool.execute({ name: "deploy" });
    expect(body).toContain("SHOULDNOTBERESIDENT");

    await expect(tool.execute({ name: "nope" })).rejects.toThrow(/No skill named/);
  });
});
