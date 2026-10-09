/**
 * Plugin trust gate — the fix for the "third-party hooks run at the same
 * privilege as built-ins" weakness observed in ZCode-style harnesses.
 *
 * A plugin (which can ship HOOKS — arbitrary shell commands!) loads only if
 * the user has explicitly trusted its content fingerprint. Any file change
 * invalidates the trust (fail-closed: disabled until re-trusted).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TrustRecord {
  fingerprint: string;
  trustedAt: string;
}

export function trustStoreFile(): string {
  return path.join(os.homedir(), ".loom", "trust.json");
}

function readStore(storeFile: string): Record<string, TrustRecord> {
  try {
    return JSON.parse(fs.readFileSync(storeFile, "utf8"));
  } catch {
    return {};
  }
}

function writeStore(storeFile: string, store: Record<string, TrustRecord>): void {
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), "utf8");
}

/** Content fingerprint: every file path + content, order-independent. */
export function fingerprintDir(dir: string): string {
  const entries: Array<[string, string]> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = path.relative(dir, full);
        entries.push([rel, fs.readFileSync(full, "utf8")]);
      }
    }
  };
  walk(dir);
  entries.sort(([a], [b]) => (a < b ? -1 : 1));
  const hash = crypto.createHash("sha256");
  for (const [rel, content] of entries) {
    hash.update(rel);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function pluginKey(scope: string, name: string): string {
  return `${scope}/${name}`;
}

export type TrustStatus = "trusted" | "untrusted" | "changed";

export function checkTrust(
  scope: string,
  name: string,
  dir: string,
  storeFile = trustStoreFile(),
): { status: TrustStatus; fingerprint: string } {
  const fingerprint = fingerprintDir(dir);
  const record = readStore(storeFile)[pluginKey(scope, name)];
  if (!record) return { status: "untrusted", fingerprint };
  if (record.fingerprint !== fingerprint) return { status: "changed", fingerprint };
  return { status: "trusted", fingerprint };
}

export function trust(
  scope: string,
  name: string,
  dir: string,
  storeFile = trustStoreFile(),
): TrustRecord {
  const store = readStore(storeFile);
  const record: TrustRecord = { fingerprint: fingerprintDir(dir), trustedAt: new Date().toISOString() };
  store[pluginKey(scope, name)] = record;
  writeStore(storeFile, store);
  return record;
}

export function untrust(scope: string, name: string, storeFile = trustStoreFile()): boolean {
  const store = readStore(storeFile);
  const existed = delete store[pluginKey(scope, name)];
  if (existed) writeStore(storeFile, store);
  return existed;
}
