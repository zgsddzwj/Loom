/**
 * Plugin loader. A plugin is a directory (user-level ~/.loom/plugins/<name>/
 * or project-level .loom/plugins/<name>/) containing:
 *
 *   plugin.json   — { name, version, description }
 *   skills/<s>/SKILL.md
 *   commands/*.md — slash commands (frontmatter description, $ARGUMENTS body)
 *   hooks.json    — HookRunner-shaped config { <Event>: [{ matcher, command, timeout }] }
 *
 * SECURITY: plugins load only when their fingerprint is trusted (see
 * trust.ts). Untrusted or changed plugins are skipped with a warning —
 * a plugin can carry arbitrary shell hooks, so this gate is fail-closed.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "../skills/loader.js";
import { loadSkillDir } from "../skills/loader.js";
import { parseCommandFile, type SlashCommand } from "../commands/loader.js";
import type { HooksConfig } from "../hooks/runner.js";
import { checkTrust, type TrustStatus } from "./trust.js";

export interface PluginOnDisk {
  name: string;
  dir: string;
  source: "user" | "project";
}

export interface LoadedPlugin {
  name: string;
  version?: string;
  description?: string;
  source: "user" | "project";
  status: TrustStatus;
  skills: Skill[];
  commands: SlashCommand[];
  hooks: HooksConfig;
}

export function discoverPlugins(cwd: string, userRoot = path.join(os.homedir(), ".loom", "plugins")): PluginOnDisk[] {
  const found: PluginOnDisk[] = [];
  const seen = new Set<string>();
  for (const [root, source] of [
    [userRoot, "user"],
    [path.join(cwd, ".loom", "plugins"), "project"],
  ] as const) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = path.join(root, name);
      if (!fs.existsSync(path.join(dir, "plugin.json"))) continue;
      const key = `${source}/${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ name, dir, source });
    }
  }
  return found;
}

function loadHooks(dir: string): HooksConfig {
  const file = path.join(dir, "hooks.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed ? (parsed as HooksConfig) : {};
  } catch {
    return {};
  }
}

export function loadPlugin(
  plugin: PluginOnDisk,
  warn: (msg: string) => void,
  storeFile?: string,
): LoadedPlugin {
  const trust = checkTrust(plugin.source, plugin.name, plugin.dir, storeFile);
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin.dir, "plugin.json"), "utf8")) as {
    name?: string;
    version?: string;
    description?: string;
  };

  const result: LoadedPlugin = {
    name: manifest.name ?? plugin.name,
    version: manifest.version,
    description: manifest.description,
    source: plugin.source,
    status: trust.status,
    skills: [],
    commands: [],
    hooks: {},
  };

  if (trust.status !== "trusted") {
    warn(
      trust.status === "untrusted"
        ? `plugin "${plugin.name}" (${plugin.source}) is NOT trusted — skipped. ` +
          `Run: loom plugin trust ${plugin.name}`
        : `plugin "${plugin.name}" (${plugin.source}) CHANGED since it was trusted — disabled. ` +
          `Re-verify and run: loom plugin trust ${plugin.name}`,
    );
    return result;
  }

  const skillsRoot = path.join(plugin.dir, "skills");
  try {
    for (const entry of fs.readdirSync(skillsRoot)) {
      const skill = loadSkillDir(path.join(skillsRoot, entry), plugin.source);
      if (skill) result.skills.push(skill);
    }
  } catch {
    /* no skills dir */
  }

  const commandsRoot = path.join(plugin.dir, "commands");
  try {
    for (const entry of fs.readdirSync(commandsRoot)) {
      if (!entry.endsWith(".md")) continue;
      const cmd = parseCommandFile(path.join(commandsRoot, entry), `plugin:${plugin.name}`);
      if (cmd) result.commands.push(cmd);
    }
  } catch {
    /* no commands dir */
  }

  result.hooks = loadHooks(plugin.dir);
  return result;
}

export function loadAllPlugins(
  cwd: string,
  warn: (msg: string) => void,
  userRoot?: string,
  storeFile?: string,
): LoadedPlugin[] {
  return discoverPlugins(cwd, userRoot).map((p) => loadPlugin(p, warn, storeFile));
}
