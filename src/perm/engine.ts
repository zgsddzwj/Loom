/**
 * Permission engine — CLIENT-ENFORCED (Claude Code principle):
 * "rules are enforced by the harness, not by the model — prompt instructions
 * cannot change what is allowed."
 *
 * Modes: default | acceptEdits | plan | bypassPermissions.
 * Rules: gitignore-ish specs like `Bash(git push:*)` with allow/ask/deny.
 * Precedence among matching rules: deny > ask > allow. Unmatched calls fall
 * back to mode defaults. In non-interactive sessions, "ask" resolves to DENY
 * (fail-closed, dsh principle).
 */

export type PermMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface AskIO {
  ask(desc: string): Promise<boolean>;
}

export interface PermRule {
  tool: string;
  pattern?: string;
  effect: "allow" | "ask" | "deny";
}

export interface PermDecision {
  effect: "allow" | "deny";
  reason?: string;
  asked?: boolean;
}

/** Parse "Bash(git push:*)" into {tool, pattern}; bare "Bash" matches all bash. */
export function parseRuleSpec(spec: string, effect: PermRule["effect"]): PermRule {
  const m = spec.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((.+)\))?$/);
  if (!m) throw new Error(`Invalid permission rule spec: "${spec}"`);
  return { tool: m[1], pattern: m[2], effect };
}

function ruleMatches(rule: PermRule, subject: string): boolean {
  if (rule.pattern === undefined) return true;
  if (rule.pattern.endsWith(":*")) return subject.startsWith(rule.pattern.slice(0, -2));
  return subject === rule.pattern;
}

function subjectOf(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "bash":
      return String(input.command ?? "");
    case "read":
    case "edit":
    case "write":
      return String(input.file ?? "");
    case "grep":
    case "glob":
      return String(input.path ?? ".");
    default:
      return JSON.stringify(input ?? {});
  }
}

export interface PermissionHookIO {
  /** Fired before an interactive ask; may short-circuit allow/deny. */
  onAsk(tool: string, input: Record<string, unknown>): Promise<{ decision?: string; reason?: string }>;
}

export class PermissionEngine {
  constructor(
    private mode: PermMode,
    private rules: PermRule[],
    private io?: AskIO,
    private hookIO?: PermissionHookIO,
  ) {}

  setMode(m: PermMode): void {
    this.mode = m;
  }
  getMode(): PermMode {
    return this.mode;
  }

  async check(
    tool: { name: string; readonly: boolean },
    input: Record<string, unknown>,
  ): Promise<PermDecision> {
    if (this.mode === "bypassPermissions") return { effect: "allow" };

    // Read-only tools (and the plan gate itself) are always safe.
    if (tool.readonly) return { effect: "allow" };

    if (this.mode === "plan") {
      return {
        effect: "deny",
        reason:
          "Plan mode is active: only read-only tools are available. " +
          "Research with read/grep/glob, then present your plan via exit_plan.",
      };
    }

    const subject = subjectOf(tool.name, input);
    const matched = this.rules.filter(
      (r) => r.tool.toLowerCase() === tool.name.toLowerCase() && ruleMatches(r, subject),
    );

    const deny = matched.find((r) => r.effect === "deny");
    if (deny) {
      return { effect: "deny", reason: `denied by permission rule ${deny.tool}(${deny.pattern ?? "*"})` };
    }
    const ask = matched.find((r) => r.effect === "ask");
    if (ask) return this.doAsk(tool.name, input, subject);
    const allow = matched.find((r) => r.effect === "allow");
    if (allow) return { effect: "allow" };

    // Mode defaults
    const isEdit = tool.name === "edit" || tool.name === "write";
    if (this.mode === "acceptEdits" && isEdit) return { effect: "allow" };
    return this.doAsk(tool.name, input, subject);
  }

  private async doAsk(
    name: string,
    input: Record<string, unknown>,
    subject: string,
  ): Promise<PermDecision> {
    if (this.hookIO) {
      const h = await this.hookIO.onAsk(name, input);
      if (h.decision === "allow") return { effect: "allow", reason: h.reason };
      if (h.decision === "deny") return { effect: "deny", reason: h.reason ?? "denied by PermissionRequest hook" };
    }
    if (!this.io) {
      return {
        effect: "deny",
        reason:
          "non-interactive session and no allow rule matched — denied (fail-closed). " +
          "Add an allow rule in .loom/config.json or run interactively.",
      };
    }
    const desc = `${name}(${subject.slice(0, 120)})`;
    const ok = await this.io.ask(desc);
    return ok
      ? { effect: "allow", asked: true }
      : { effect: "deny", reason: "denied by user", asked: true };
  }
}
