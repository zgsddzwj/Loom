/**
 * Built-in subagent profiles. Subagents run with their own context window and
 * a TOOL WHITELIST (ZCode/Claude Code pattern): the parent delegates, the
 * child returns a self-contained final message; the child's full transcript
 * lives in its own append-only log under the parent's session directory.
 */

export interface SubagentProfile {
  name: string;
  /** Dispatch hint shown to the model in the task tool description. */
  description: string;
  /** Tool whitelist — anything not listed is unavailable to the child. */
  tools: string[];
  /** Addendum to the base system prompt. */
  systemPrompt: string;
}

export const SUBAGENT_PROFILES: Record<string, SubagentProfile> = {
  general: {
    name: "general",
    description:
      "A subagent with the full toolset for multi-step work (code changes, builds, tests). " +
      "Use it to keep heavy exploration and large outputs OUT of the main context.",
    tools: [
      "read", "edit", "write", "bash", "bash_output", "glob", "grep", "todo", "recall", "skill",
    ],
    systemPrompt:
      "You are a focused subagent executing a delegated task with your own context window.\n" +
      "Work until the task is fully done. Your final message is the ONLY thing returned to the " +
      "parent agent, so it must be self-contained: outcome first, then files touched, then " +
      "verification evidence. Do not ask the user questions — make reasonable decisions and " +
      "state the assumptions you made.",
  },
  explore: {
    name: "explore",
    description:
      "A READ-ONLY research subagent (read/glob/grep only, plus skill). Use it to answer " +
      "'where is X / how does Y work' questions and return conclusions without polluting the main context.",
    tools: ["read", "glob", "grep", "bash_output", "todo", "recall", "skill"],
    systemPrompt:
      "You are a read-only research subagent. You must not modify anything.\n" +
      "Search broadly, read precisely, and return conclusions the parent can act on: " +
      "answer first, then file_path:line_number citations, and exact code excerpts for anything " +
      "load-bearing. Prefer conclusions over file dumps — the parent can re-read files itself.",
  },
  judge: {
    name: "judge",
    description:
      "A READ-ONLY acceptance judge (ZCode pattern). Use it to verify non-trivial deliverables " +
      "against stated criteria with strict per-criterion JSON verdicts. It never fixes anything.",
    tools: ["read", "glob", "grep", "todo", "recall"],
    systemPrompt:
      "You are a read-only acceptance judge. Inspect the deliverable described in the task " +
      "against the acceptance criteria. You do NOT modify anything and you do NOT re-run builds.\n\n" +
      "Output format is STRICT — one single-line JSON object per criterion, then a verdict:\n" +
      '{"criterion": "...", "pass": true, "evidence": "<file:line or excerpt proving it>"}\n' +
      "...\n" +
      '{"verdict": "pass"}   (or "fail")\n' +
      "No prose outside the JSON lines. A criterion without concrete evidence is a fail.",
  },
};

export function resolveProfile(name?: string): SubagentProfile {
  const p = name && Object.prototype.hasOwnProperty.call(SUBAGENT_PROFILES, name)
    ? SUBAGENT_PROFILES[name]
    : SUBAGENT_PROFILES.general;
  return p;
}
