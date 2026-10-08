#!/usr/bin/env node
/**
 * Loom CLI.
 *
 *   loom                        interactive REPL
 *   loom -p "prompt"            one-shot headless (permissions fail-closed)
 *   loom --resume [id|latest]   continue a session
 *   loom --plan                 start in plan mode
 *   loom replay [id] [--json] [--verify]   rebuild the exact model-visible
 *                                           context from the append-only log
 */

import * as fs from "node:fs";
import * as path from "node:path";
import readline from "node:readline/promises";
import { EventLog } from "./log/eventlog.js";
import { project } from "./log/projector.js";
import { ArtifactStore } from "./context/artifacts.js";
import { ContextManager, makeAdapterSummarizer } from "./context/manager.js";
import { estimateRequestTokens } from "./context/tokens.js";
import { resolveModel } from "./providers/catalog.js";
import { ReadState } from "./tools/readstate.js";
import { readTool, editTool, writeTool } from "./tools/files.js";
import { bashTool, bashOutputTool } from "./tools/bash.js";
import { globTool, grepTool } from "./tools/search.js";
import { todoTool, type TodoItem } from "./tools/todo.js";
import { recallTool } from "./tools/recall.js";
import { exitPlanTool } from "./tools/plan.js";
import { ToolRegistry, type ToolContext, type ToolIO } from "./tools/registry.js";
import { PermissionEngine, parseRuleSpec, type PermMode } from "./perm/engine.js";
import { HookRunner } from "./hooks/runner.js";
import { loadAgentInstructions } from "./memory/agentsmd.js";
import { buildSystemPrompt } from "./sysprompt.js";
import { runTurn, type LoopIO, type LoopDeps } from "./core/loop.js";
import { loadConfig, sessionsRoot } from "./config.js";

const isTTY = process.stdout.isTTY ?? false;
const paint = (code: string) => (s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const bold = paint("1");
const green = paint("32");
const cyan = paint("36");
const yellow = paint("33");
const red = paint("31");

const ALL_TOOLS = [
  readTool,
  editTool,
  writeTool,
  bashTool,
  bashOutputTool,
  globTool,
  grepTool,
  todoTool,
  recallTool,
];

function printHelp(): void {
  console.log(`Loom — small core, everything logged, everything composable.

Usage:
  loom                              interactive session
  loom -p "do X"                    one-shot headless run (ask => deny, fail-closed)
  loom --resume [id|latest]         resume a session
  loom replay [id] [--json] [--verify]   show / dump the exact model-visible context

Flags:
  --model <id>            model id, or anthropic:<id> / openai:<id>, or env LOOM_MODEL
  --mode <m>              default | acceptEdits | plan | bypassPermissions
  --plan                  shorthand for --mode plan
  --accept-edits         shorthand for --mode acceptEdits
  --bypass               shorthand for --mode bypassPermissions (use only in a sandbox)
  --max-steps <n>        per-turn step budget (default 200)
  --compact-threshold <n>  compaction trigger in estimated tokens

Config: ~/.loom/config.json and .loom/config.json (project wins). Keys are read
ONLY from env vars: LOOM_API_KEY / LOOM_BASE_URL / LOOM_MODEL, or provider keys
(ZHIPU_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, MOONSHOT_API_KEY).

REPL commands: /help /quit /mode <m> /plan /compact /todos /session`);
}

function renderTodos(todos: TodoItem[]): void {
  if (todos.length === 0) return;
  const lines = todos.map(
    (t) =>
      `  ${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[*]" : "[ ]"} ${t.content}`,
  );
  console.log(cyan("todos:") + "\n" + lines.join("\n"));
}

function preview(s: string, n = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + " …" : one;
}

function summarizeInput(input: Record<string, unknown>): string {
  const s = JSON.stringify(input ?? {});
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}

async function cmdReplay(args: string[]): Promise<void> {
  let id = "latest";
  let json = false;
  let verify = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a === "--verify") verify = true;
    else id = a;
  }
  const root = sessionsRoot();
  const sessions = EventLog.listSessions(root);
  const dir =
    id === "latest"
      ? sessions[0]
      : fs.existsSync(path.join(root, id))
        ? path.join(root, id)
        : sessions.find((p) => path.basename(p).includes(id));
  if (!dir) {
    console.error(red(`No session found for "${id}".`));
    process.exit(1);
  }
  const log = EventLog.open(dir);
  const proj = project(log.list());
  const system = buildSystemPrompt(loadAgentInstructions(log.cwd));
  const ctx: ToolContext = {
    cwd: log.cwd,
    sessionDir: log.sessionDir,
    artifacts: new ArtifactStore(path.join(log.sessionDir, "artifacts")),
    readState: new ReadState(),
    jobs: new Map(),
    io: {},
  };
  const tools = new ToolRegistry([...ALL_TOOLS, exitPlanTool], ctx).schemas();
  const tokens = estimateRequestTokens(system, proj.messages, tools);

  console.log(bold(`replay: ${log.sessionId}`));
  console.log(`  log:      ${log.file}`);
  console.log(`  events:   ${log.list().length}`);
  console.log(`  messages: ${proj.messages.length} (compacted: ${proj.compacted ? "yes" : "no"})`);
  console.log(`  est. tokens of the model-visible request: ~${tokens}`);
  if (verify) {
    const again = project(log.list());
    const deterministic = JSON.stringify(again) === JSON.stringify(proj);
    console.log(`  deterministic projection: ${deterministic ? "yes ✓" : red("NO")}`);
  }
  if (json) {
    console.log(JSON.stringify({ system, tools, messages: proj.messages }, null, 2));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "replay") return cmdReplay(args.slice(1));
  if (["-h", "--help", "help"].includes(args[0] ?? "")) return printHelp();

  let print = false;
  let promptArgs: string[] = [];
  let model: string | undefined;
  let mode: PermMode | undefined;
  let resumeId: string | undefined;
  let maxSteps: number | undefined;
  let compactThreshold: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "-p":
      case "--print":
        print = true;
        break;
      case "--model":
        model = args[++i];
        break;
      case "--mode":
        mode = args[++i] as PermMode;
        break;
      case "--plan":
        mode = "plan";
        break;
      case "--accept-edits":
        mode = "acceptEdits";
        break;
      case "--bypass":
        mode = "bypassPermissions";
        break;
      case "--resume":
        resumeId = args[++i] ?? "latest";
        break;
      case "--max-steps":
        maxSteps = Number(args[++i]);
        break;
      case "--compact-threshold":
        compactThreshold = Number(args[++i]);
        break;
      default:
        if (a.startsWith("--")) {
          console.error(red(`Unknown flag: ${a}`));
          printHelp();
          process.exit(2);
        }
        promptArgs.push(a);
    }
  }

  const cwd = process.cwd();
  const config = loadConfig(cwd);
  mode = mode ?? config.mode ?? "default";

  const resolved = resolveModel(model ?? config.model);
  const spec = resolved.spec;

  const root = sessionsRoot();
  let log: EventLog;
  if (resumeId) {
    const sessions = EventLog.listSessions(root);
    const dir =
      resumeId === "latest"
        ? sessions[0]
        : fs.existsSync(path.join(root, resumeId))
          ? path.join(root, resumeId)
          : sessions.find((p) => path.basename(p).includes(resumeId!));
    if (!dir) {
      console.error(red(`No session found for --resume ${resumeId}`));
      process.exit(1);
    }
    log = EventLog.open(dir);
  } else {
    log = EventLog.create(root, { cwd, model: spec.id, provider: spec.api });
  }

  const artifacts = new ArtifactStore(path.join(log.sessionDir, "artifacts"));
  const hooks = new HookRunner(config.hooks ?? {}, cwd, (m) =>
    console.error(yellow(`[hook] ${m}`)),
  );

  const ss = await hooks.run("SessionStart", { sessionId: log.sessionId, cwd });
  if (ss.blocked) console.error(yellow(`[hook] SessionStart blocked: ${ss.reason}`));
  if (ss.additionalContext) {
    log.append({ t: "context/message", kind: "injected", text: ss.additionalContext });
  }

  const readState = new ReadState();
  const jobs = new Map();
  let currentTodos: TodoItem[] = [];
  const toolIO: ToolIO = {
    onTodo: (todos) => {
      currentTodos = todos;
      if (!print) renderTodos(todos);
    },
  };
  const ctx: ToolContext = {
    cwd,
    sessionDir: log.sessionDir,
    artifacts,
    readState,
    jobs,
    io: toolIO,
  };

  const rules = [
    ...(config.permissions?.deny ?? []).map((s) => parseRuleSpec(s, "deny")),
    ...(config.permissions?.ask ?? []).map((s) => parseRuleSpec(s, "ask")),
    ...(config.permissions?.allow ?? []).map((s) => parseRuleSpec(s, "allow")),
  ];

  const systemText = buildSystemPrompt(loadAgentInstructions(cwd));
  const threshold =
    compactThreshold ??
    config.context?.compactThresholdTokens ??
    Math.min(60_000, Math.floor(spec.contextWindow / 2));
  const pruneBytes = config.context?.pruneBytes ?? 30_000;
  const stepBudget = maxSteps ?? config.maxSteps ?? 200;

  const buildDefs = (m: PermMode) => [
    ...ALL_TOOLS,
    ...(m === "plan" ? [exitPlanTool] : []),
  ];

  const hookAsk = async (tool: string, input: Record<string, unknown>) => {
    const h = await hooks.run("PermissionRequest", { tool, input });
    return { decision: h.decision as "allow" | "deny" | "ask" | undefined, reason: h.reason };
  };

  if (print) {
    const prompt = promptArgs.join(" ").trim();
    if (!prompt) {
      console.error(red("loom -p requires a prompt."));
      process.exit(2);
    }
    const registry = new ToolRegistry(buildDefs(mode), ctx, pruneBytes);
    // Headless: no interactive approval — plan gate and asks fail closed.
    const perm = new PermissionEngine(mode, rules, undefined, { onAsk: hookAsk });
    const io: LoopIO = {
      onText: (d) => process.stdout.write(d),
      onToolCall: () => {},
      onToolResult: () => {},
      onNotice: (m) => console.error(yellow(`[loom] ${m}`)),
    };
    const deps: LoopDeps = {
      log,
      adapter: resolved.adapter,
      registry,
      perm,
      hooks,
      ctx,
      ctxManager: new ContextManager({
        log,
        artifacts,
        summarizer: makeAdapterSummarizer(resolved.adapter),
        thresholdTokens: threshold,
      }),
      io,
      maxSteps: stepBudget,
      buildSystem: () => systemText,
    };
    await runTurn(deps, prompt);
    process.exit(0);
  }

  // ---------- interactive REPL ----------
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let abort: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (abort) {
      abort.abort();
    } else {
      rl.close();
      process.exit(0);
    }
  });

  const ask = async (desc: string): Promise<boolean> => {
    const a = await rl.question(red(`  Allow ${desc}? [y/N] `));
    return /^y(es)?$/i.test(a.trim());
  };
  const approvePlan = async (plan: string): Promise<boolean> => {
    console.log("\n" + bold("--- PLAN ---") + "\n\n" + plan + "\n");
    const a = await rl.question(bold("Approve this plan? [y/N] "));
    return /^y(es)?$/i.test(a.trim());
  };

  const perm = new PermissionEngine(mode, rules, { ask }, { onAsk: hookAsk });
  const ctxManager = new ContextManager({
    log,
    artifacts,
    summarizer: makeAdapterSummarizer(resolved.adapter),
    thresholdTokens: threshold,
  });

  console.log(bold("Loom") + dim(` v0.1.0 — small core, everything logged, everything composable`));
  console.log(
    dim(
      `session ${log.sessionId} | model ${spec.id} (${spec.api}) | mode ${perm.getMode()} | threshold ~${threshold} tok`,
    ),
  );
  console.log(dim(`log ${log.file}`));
  console.log(dim(`type /help for commands`));

  for (;;) {
    const line = (await rl.question(green(`loom(${perm.getMode()})> `))).trim();
    if (!line) continue;

    if (line === "/quit" || line === "/exit") break;
    if (line === "/help") {
      printHelp();
      continue;
    }
    if (line === "/todos") {
      renderTodos(currentTodos);
      continue;
    }
    if (line === "/session") {
      const proj = project(log.list());
      console.log(
        `session ${log.sessionId}\n  events ${log.list().length} | messages ${proj.messages.length} | compacted ${proj.compacted}\n  log ${log.file}`,
      );
      continue;
    }
    if (line === "/plan") {
      const next: PermMode = perm.getMode() === "plan" ? "default" : "plan";
      perm.setMode(next);
      ctx.planGate = next === "plan" ? { approve: approvePlan } : undefined;
      console.log(dim(`mode -> ${next}`));
      continue;
    }
    if (line.startsWith("/mode")) {
      const m = line.slice(5).trim() as PermMode;
      if (!["default", "acceptEdits", "plan", "bypassPermissions"].includes(m)) {
        console.error(red(`unknown mode "${m}" (default | acceptEdits | plan | bypassPermissions)`));
        continue;
      }
      perm.setMode(m);
      ctx.planGate = m === "plan" ? { approve: approvePlan } : undefined;
      console.log(dim(`mode -> ${m}`));
      continue;
    }
    if (line === "/compact") {
      const messages = project(log.list()).messages;
      const ok = await ctxManager.forceCompact(systemText, messages, new ToolRegistry(buildDefs(perm.getMode()), ctx, pruneBytes).schemas());
      console.log(ok ? yellow("compacted (full history spilled; recall via locator in the summary)") : dim("nothing to compact"));
      continue;
    }
    if (line.startsWith("/")) {
      console.error(dim(`unknown command ${line} — try /help`));
      continue;
    }

    if (perm.getMode() === "plan") ctx.planGate = { approve: approvePlan };

    abort = new AbortController();
    const registry = new ToolRegistry(buildDefs(perm.getMode()), ctx, pruneBytes);
    const io: LoopIO = {
      onText: (d) => process.stdout.write(d),
      onToolCall: (call) => process.stdout.write("\n" + cyan(`⏺ ${call.name}(${summarizeInput(call.input)})`)),
      onToolResult: (r) =>
        process.stdout.write(
          "\n" + dim(r.isError ? red("  ✗ " + preview(r.content)) : "  " + preview(r.content)),
        ),
      onNotice: (m) => process.stdout.write("\n" + yellow(`[loom] ${m}`)),
      onTurnEnd: (info) => {
        if (info.usage) {
          console.log(
            dim(
              `\n  [${info.steps} steps | in:${info.usage.input ?? "?"} out:${info.usage.output ?? "?"} tokens]`,
            ),
          );
        }
      },
    };
    const deps: LoopDeps = {
      log,
      adapter: resolved.adapter,
      registry,
      perm,
      hooks,
      ctx,
      ctxManager,
      io,
      maxSteps: stepBudget,
      buildSystem: () => systemText,
      signal: abort.signal,
    };
    try {
      await runTurn(deps, line);
    } catch (e) {
      console.error(red(`\n[loom] turn failed: ${(e as Error).message}`));
    }
    abort = null;
    process.stdout.write("\n");
  }
  rl.close();
}

main().catch((e) => {
  console.error(red(`[loom] ${e instanceof Error ? e.message : String(e)}`));
  process.exit(1);
});
