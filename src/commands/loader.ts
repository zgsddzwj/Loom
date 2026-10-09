/**
 * Slash commands: reusable prompt templates. Sources (priority: project >
 * user > plugin): <cwd>/.loom/commands/*.md, ~/.loom/commands/*.md, and
 * trusted plugins' commands/*.md. Body replaces $ARGUMENTS with the rest of
 * the input line. Built-in REPL commands always win on name collisions.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SlashCommand {
  name: string;
  description: string;
  body: string;
  source: string;
}

/** Parse a command .md file: `---\ndescription: ...\n---\nbody`. */
export function parseCommandFile(file: string, source: string): SlashCommand | null {
  try {
    const text = fs.readFileSync(file, "utf8");
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) {
      // no frontmatter: whole file is the body
      return {
        name: path.basename(file, ".md"),
        description: "(no description)",
        body: text.trim(),
        source,
      };
    }
    const meta: Record<string, string> = {};
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
    if (!m[2].trim()) return null;
    return {
      name: path.basename(file, ".md"),
      description: meta.description ?? "(no description)",
      body: m[2].trim(),
      source,
    };
  } catch {
    return null;
  }
}

function scanDir(dir: string, source: string): SlashCommand[] {
  const out: SlashCommand[] = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const cmd = parseCommandFile(path.join(dir, entry), source);
      if (cmd) out.push(cmd);
    }
  } catch {
    /* dir missing */
  }
  return out;
}

/** project > user > plugin priority on name collisions. */
export function discoverCommands(
  cwd: string,
  pluginCommands: SlashCommand[] = [],
  userRoot = path.join(os.homedir(), ".loom", "commands"),
): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const cmd of [
    ...pluginCommands,
    ...scanDir(userRoot, "user"),
    ...scanDir(path.join(cwd, ".loom", "commands"), "project"),
  ]) {
    byName.set(cmd.name, cmd); // later sources win
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCommand(cmd: SlashCommand, args: string): string {
  return cmd.body.replace(/\$ARGUMENTS\b/g, args.trim());
}
