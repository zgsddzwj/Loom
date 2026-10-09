/**
 * OS-level sandbox (Codex pattern): the safety base that makes automatic
 * execution trustworthy. Applied to every bash command when the permission
 * engine runs in bypassPermissions mode (or --sandbox forces it).
 *
 * - macOS: Seatbelt via `sandbox-exec` profile — system-wide read, writes
 *   confined to the workspace + session dir, no network. Two SBPL syntax
 *   generations exist (`(subpath "p")` vs `(subpath (literal "p"))`); the
 *   compiling variant is probed ONCE at creation, fail-closed if neither.
 *   Writable paths must be realpath-canonical: /var symlinks to /private/var
 *   and subpath filters match the resolved path.
 * - Linux: `bwrap` (bubblewrap) with the same policy; unavailable => null.
 *
 * The sandbox is enforced by the OS, not by the model — same principle as
 * the permission engine: never trust self-restraint.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SandboxKind = "seatbelt" | "bwrap";

export interface Sandbox {
  kind: SandboxKind;
  /** Wrap a shell command to run inside the sandbox. null = cannot run (fail-closed). */
  wrap(command: string): string | null;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function realpathSafe(p: string): string {
  const abs = path.resolve(p);
  // Paths may not exist yet (e.g. the artifacts dir): canonicalize via the
  // deepest EXISTING ancestor and re-append the missing segments — a
  // symlinked /var-style path in the profile silently matches nothing.
  let cur = abs;
  const suffix: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    suffix.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    return path.join(fs.realpathSync(cur), ...suffix);
  } catch {
    return abs;
  }
}

function seatbeltProfile(writableDirs: string[], legacy: boolean): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow file-read*)",
    '(allow file-write* (literal "/dev/null"))',
    "(deny network*)",
  ];
  for (const dir of writableDirs) {
    lines.push(legacy ? `(allow file-write* (subpath (literal "${dir}")))` : `(allow file-write* (subpath "${dir}"))`);
  }
  return lines.join("\n") + "\n";
}

function bwrapCommand(writableDirs: string[], command: string): string {
  const args = [
    "bwrap", "--unshare-net", "--die-with-parent",
    "--ro-bind", "/", "/",
    "--proc", "/proc",
    "--dev", "/dev",
  ];
  for (const dir of writableDirs) {
    args.push("--bind", dir, dir);
  }
  args.push("--", "/bin/sh", "-c", command);
  return args.map((a) => (/[\s"']/.test(a) ? shellQuote(a) : a)).join(" ");
}

export function detectSandbox(): SandboxKind | null {
  if (process.platform === "darwin") {
    try {
      const r = spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
        stdio: "ignore",
        timeout: 5000,
      });
      if (!r.error && r.status === 0) return "seatbelt";
    } catch {
      /* not available */
    }
    return null;
  }
  try {
    const r = spawnSync("bwrap", ["--version"], { stdio: "ignore", timeout: 5000 });
    if (!r.error) return "bwrap";
  } catch {
    /* not available */
  }
  return null;
}

export function createSandbox(cwd: string, extraWritableDirs: string[] = []): Sandbox | null {
  const kind = detectSandbox();
  if (!kind) return null;
  const dirs = [...new Set([cwd, ...extraWritableDirs].map(realpathSafe))];

  if (kind === "seatbelt") {
    // Probe the two SBPL generations once; keep the compiled profile for the
    // whole session (its content only depends on the writable dirs).
    let profileFile: string | null = null;
    for (const legacy of [false, true]) {
      const f = path.join(os.tmpdir(), `loom-sb-${process.pid}.sb`);
      try {
        fs.writeFileSync(f, seatbeltProfile(dirs, legacy), "utf8");
        const r = spawnSync("sandbox-exec", ["-f", f, "/usr/bin/true"], {
          stdio: "ignore",
          timeout: 5000,
        });
        if (r.status === 0) {
          profileFile = f;
          break;
        }
      } catch {
        /* try the next variant */
      }
    }
    if (!profileFile) return null; // neither syntax compiles: fail-closed
    // Fixed /bin/bash inside the sandbox: user shells (zsh) write state files
    // (zcompdump, history) at startup, which (deny default) breaks.
    return {
      kind,
      wrap(command: string) {
        return `sandbox-exec -f ${shellQuote(profileFile!)} /bin/bash -c ${shellQuote(command)}`;
      },
    };
  }

  return {
    kind,
    wrap(command: string) {
      try {
        return bwrapCommand(dirs, command);
      } catch {
        return null;
      }
    },
  };
}
