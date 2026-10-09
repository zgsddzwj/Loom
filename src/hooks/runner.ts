/**
 * Hook runner — 7 lifecycle events (Claude Code / ZCode compatible set).
 *
 * Events: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest,
 * PostToolUse, PostToolUseFailure, Stop.
 *
 * Contract:
 * - hook = shell command; receives the JSON payload on stdin;
 *   env LOOM_EVENT, LOOM_PROJECT_DIR are set.
 * - exit code 2 => BLOCK (PreToolUse blocks the call; Stop blocks stopping).
 * - stdout may carry a JSON object: { decision?: "allow"|"deny"|"ask",
 *   reason?: string, additionalContext?: string }.
 * - a crashing hook is advisory (warn + ignore); explicit exit 2 is the
 *   deliberate block signal.
 */

import { spawnSync } from "node:child_process";

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop";

export const HOOK_EVENTS: HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

export interface HookSpec {
  matcher?: string; // regex against the tool name, for tool events
  command: string;
  timeout?: number; // seconds
}

export type HooksConfig = Partial<Record<HookEvent, HookSpec[]>>;

export interface HookOutcome {
  blocked?: boolean;
  reason?: string;
  additionalContext?: string;
  decision?: "allow" | "deny" | "ask";
}

export class HookRunner {
  constructor(
    private cfg: HooksConfig,
    private projectDir: string,
    private warn: (msg: string) => void = () => {},
  ) {}

  async run(event: HookEvent, payload: Record<string, unknown>): Promise<HookOutcome> {
    const specs = (this.cfg[event] ?? []).filter((s) => {
      if (!s.matcher) return true;
      try {
        return new RegExp(s.matcher, "i").test(String(payload.tool ?? ""));
      } catch {
        return false;
      }
    });
    const out: HookOutcome = {};
    for (const s of specs) {
      let r: ReturnType<typeof spawnSync> | undefined;
      // Try the user's shell first; on any spawn failure retry once with
      // /bin/sh (covers exotic SHELL values and transient EAGAIN under load).
      const shells = [process.env.SHELL || "/bin/bash", "/bin/sh"];
      let lastError: string | undefined;
      for (const shell of shells) {
        try {
          const attempt = spawnSync(shell, ["-c", s.command], {
            input: JSON.stringify(payload),
            env: { ...process.env, LOOM_EVENT: event, LOOM_PROJECT_DIR: this.projectDir },
            timeout: (s.timeout ?? 10) * 1000,
            maxBuffer: 10 * 1024 * 1024,
            encoding: "utf8",
          });
          if (!attempt.error) {
            r = attempt;
            break;
          }
          lastError = attempt.error.message;
        } catch (e) {
          lastError = (e as Error).message;
        }
      }
      if (!r) {
        this.warn(`hook for ${event} failed to run: ${lastError ?? "unknown spawn error"}`);
        continue;
      }
      if (r.status === 2) {
        return { blocked: true, reason: (r.stderr || "").toString().trim() || "blocked by hook" };
      }
      const stdout = (r.stdout || "").toString().trim();
      if (stdout) {
        try {
          const j = JSON.parse(stdout);
          if (j.decision === "allow" || j.decision === "deny" || j.decision === "ask") {
            out.decision = j.decision;
          }
          if (typeof j.reason === "string") out.reason = j.reason;
          if (typeof j.additionalContext === "string") {
            out.additionalContext = (out.additionalContext ?? "") + j.additionalContext;
          }
        } catch {
          /* non-JSON stdout is ignored */
        }
      }
    }
    return out;
  }
}
