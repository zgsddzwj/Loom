/**
 * The `skill` tool: loads a SKILL.md body on demand (layer 2 of progressive
 * disclosure). The loaded body flows through the normal tool-result path,
 * so it is pruned if oversized and — as always — journaled to the log.
 */

import { ToolError } from "../tools/errors.js";
import type { ToolDef } from "../tools/registry.js";
import type { Skill } from "./loader.js";

export function makeSkillTool(skills: Skill[]): ToolDef {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    name: "skill",
    description:
      "Load the full instructions of an installed skill by name. Call this BEFORE attempting a task " +
      "that matches a skill description, then follow the loaded instructions exactly.",
    readonly: true,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name from the catalog in the system prompt." },
      },
      required: ["name"],
    },
    async execute(input) {
      const skill = byName.get(String(input.name ?? ""));
      if (!skill) {
        throw new ToolError(
          `No skill named "${input.name}". Installed: ${[...byName.keys()].sort().join(", ") || "(none)"}.`,
        );
      }
      return `# Skill: ${skill.name}\n\n${skill.body}`;
    },
  };
}
