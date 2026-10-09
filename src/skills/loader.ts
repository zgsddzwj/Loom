/**
 * Skills: progressive disclosure (Claude Code / ZCode style).
 *
 * Three layers:
 *   1. name + description are resident in the system prompt (catalog);
 *   2. the SKILL.md body loads only when the model calls the `skill` tool;
 *   3. bundled files load on demand via read (not our problem here).
 *
 * Discovery: <cwd>/.loom/skills/<name>/SKILL.md and ~/.loom/skills/<name>/SKILL.md.
 * Project skills shadow user skills with the same name (closest wins).
 * Frontmatter is minimal YAML: `name` and `description` (single-line values).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Skill {
  name: string;
  description: string;
  body: string;
  source: "user" | "project";
  dir: string;
}

const MAX_DESCRIPTION = 1024;
/** ~250 chars shown in the catalog, ZCode-style pushy-description budget. */
const CATALOG_DESCRIPTION = 250;

function parseFrontmatter(text: string): { name: string; description: string; body: string } | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  const name = meta.name;
  const description = meta.description ?? "";
  if (!name || !description || description.length > MAX_DESCRIPTION) return null;
  return { name, description, body: m[2].trim() };
}

/** Load one skill directory (exported for the plugin loader). */
export function loadSkillDir(dir: string, source: "user" | "project"): Skill | null {
  const file = path.join(dir, "SKILL.md");
  try {
    const parsed = parseFrontmatter(fs.readFileSync(file, "utf8"));
    if (!parsed) return null;
    return {
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      source,
      dir,
    };
  } catch {
    return null;
  }
}

export function discoverSkills(cwd: string, userRoot = path.join(os.homedir(), ".loom", "skills")): Skill[] {
  const found = new Map<string, Skill>();
  // user-level first, so project shadows it (loaded later overwrites)
  const projRoot = path.join(cwd, ".loom", "skills");
  for (const [root, source] of [
    [userRoot, "user"],
    [projRoot, "project"],
  ] as const) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skill = loadSkillDir(path.join(root, entry), source);
      if (skill) found.set(skill.name, skill); // same name: project wins
    }
  }
  return [...found.values()];
}

/** Catalog block for the system prompt: only name+description are resident. */
export function skillsCatalog(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills
    .map((s) => {
      const desc = s.description.length > CATALOG_DESCRIPTION ? s.description.slice(0, CATALOG_DESCRIPTION) + "…" : s.description;
      return `- ${s.name}: ${desc} [${s.source}]`;
    })
    .sort();
  return (
    "# Skills\n\n" +
    "Reusable task playbooks are installed. When the task clearly matches a skill below, " +
    "FIRST call the skill tool with its name to load the full instructions, then follow them.\n\n" +
    lines.join("\n")
  );
}
