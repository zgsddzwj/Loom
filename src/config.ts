/**
 * Config loading: ~/.loom/config.json (user) merged with
 * <cwd>/.loom/config.json (project wins per key). Secrets are NEVER stored
 * here — keys come from environment variables only.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PermMode } from "./perm/engine.js";
import type { HooksConfig } from "./hooks/runner.js";

export interface LoomConfig {
  model?: string;
  mode?: PermMode;
  maxSteps?: number;
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
  hooks?: HooksConfig;
  context?: { pruneBytes?: number; compactThresholdTokens?: number };
}

function readJson(file: string): Record<string, unknown> {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* malformed config files are ignored */
  }
  return {};
}

export function loadConfig(cwd: string): LoomConfig {
  const user = readJson(path.join(os.homedir(), ".loom", "config.json"));
  const proj = readJson(path.join(cwd, ".loom", "config.json"));
  const merged: Record<string, unknown> = { ...user, ...proj };
  return merged as LoomConfig;
}

export function loomHome(): string {
  return process.env.LOOM_HOME ?? path.join(os.homedir(), ".loom");
}

export function sessionsRoot(): string {
  return path.join(loomHome(), "sessions");
}
