#!/usr/bin/env node
/**
 * Loom CLI.
 *
 *   loom                          interactive REPL
 *   loom -p "prompt"              one-shot headless (permissions fail-closed)
 *   loom --resume [id|latest]     continue a session
 *   loom --plan | --accept-edits | --bypass [--sandbox|--no-sandbox]
 *   loom replay [id] [--json] [--verify]
 *   loom plugin list|trust|untrust [name]
 *   loom eval <tasksDir>          reproducible benchmark run
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
import { taskTool } from "./tools/task.js";
import { ToolRegistry, type ToolContext, type ToolIO, type ToolDef } from "./tools/registry.js";
import { PermissionEngine, parseRuleSpec, type PermMode } from "./perm/engine.js";
import { HookRunner, HOOK_EVENTS, type HooksConfig } from "./hooks/runner.js";
import { loadAgentInstructions } from "./memory/agentsmd.js";
import { memoryTool } from "./memory/memoryTool.js";
import { loadMemory } from "./memory/store.js";
import { composeSystemPrompt } from "./sysprompt.js";
import { discoverSkills, skillsCatalog, type Skill } from "./skills/loader.js";
import { makeSkillTool } from "./skills/skillTool.js";
import { runTurn, type LoopIO, type LoopDeps } from "./core/loop.js";
import { loadConfig, sessionsRoot, type LoomConfig } from "./config.js";
import { McpClient, type McpServerConfig } from "./mcp/client.js";
import { bridgeAllTools } from "./mcp/bridge.js";
import { createSandbox, type Sandbox } from "./sandbox/sandbox.js";
import { discoverPlugins, loadAllPlugins, type LoadedPlugin } from "./plugins/loader.js";
import { checkTrust, trust, untrust } from "./plugins/trust.js";
import { discoverCommands, expandCommand, type SlashCommand } from "./commands/loader.js";
import { makeSubagentSpawner } from "./subagents/spawn.js";
import { runEval } from "./eval/runner.js";

const isTTY = process.stdout.isTTY ?? false;
const paint = (code: string) => (s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const bold = paint("1");
const green = paint("32");
const cyan = paint("36");
const yellow = paint("33");
const red = paint("31");

const warn = (msg: string) => console.error(yellow(`[loom] ${msg}`));

const BASE_TOOLS = [
  readTool, editTool, writeTool, bashTool, bashOutputTool,
  globTool, grepTool, todoTool, recallTool, memoryTool, taskTool,
];

function printHelp(): void {
  console.log(`Loom — small core, everything logged, everything composable.

Usage:
  loom                              interactive session
  loom -p "do X"                    one-shot headless run (ask => deny, fail-closed)
  loom --resume [id|latest]         resume a session
  loom replay [id] [--json] [--verify]   show / dump the exact model-visible context
  loom plugin list | trust <n> | untrust <n>   manage plugins (fingerprint trust gate)
  loom eval <tasksDir>              reproducible benchmark run (see benchmarks/samples)

Flags:
  --model <id>            model id, or anthropic:<id> / openai:<id>, or env LOOM_MODEL
  --mode <m>              default | acceptEdits | plan | bypassPermissions
  --plan / --accept-edits / --bypass   mode shorthands
  --sandbox               force OS sandbox (fail if unavailable)
  --no-sandbox            disable sandbox even in bypass mode (unsafe)
  --max-steps <n>         per-turn step budget (default 200)
  --compact-threshold <n> compaction trigger in estimated tokens

Config: ~/.loom/config.json and .loom/config.json (project wins). Keys are read
ONLY from env vars: LOOM_API_KEY / LOOM_BASE_URL / LOOM_MODEL, or provider keys
(ZHIPU_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, MOONSHOT_API_KEY).
MCP servers: {"mcp":{"servers":{"<name>":{"command":"...","args":[...]}}}} (or top-level mcpServers).

REPL commands: /help /quit /mode <m> /plan /compact /todos /session /plugins /skills
Custom slash commands: /<name> from ~/.loom/commands, .loom/commands, and trusted plugins.`);
}

function renderTodos(todos: TodoItem[]): void {
  if (todos.length === 0) return;
  const lines = todos.map(
    (t) => `  ${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[*]" : "[ ]"} ${t.content}`,
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

function mergeHookConfigs(a: HooksConfig, b: HooksConfig): HooksConfig {
  const out: HooksConfig = {};
  for (const ev of HOOK_EVENTS) {
    const merged = [...(a[ev] ?? []), ...(b[ev] ?? [])];
    if (merged.length) out[ev] = merged;
  }
  return out;
}

// ---------------- subcommand: replay ----------------

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
  const ctx: ToolContext = {
    cwd: log.cwd,
    sessionDir: log.sessionDir,
    artifacts: new ArtifactStore(path.join(log.sessionDir, "artifacts")),
    readState: new ReadState(),
    jobs: new Map(),
    io: {},
  };
  const tools = new ToolRegistry([...BASE_TOOLS, exitPlanTool], ctx).schemas();
  const system = composeSystemPrompt({
    agents: loadAgentInstructions(log.cwd),
    memoryText: loadMemory(),
    skills: skillsCatalog(discoverSkills(log.cwd)),
  });
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

// ---------------- subcommand: plugin ----------------

async function cmdPlugin(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const [op, name] = args;
  if (!op || !["list", "trust", "untrust"].includes(op)) {
    console.error(red("Usage: loom plugin list | trust <name> | untrust <name>"));
    process.exit(2);
  }
  const plugins = discoverPlugins(cwd);
  if (op === "list") {
    if (plugins.length === 0) {
      console.log(dim("No plugins found (~/.loom/plugins/<name>/ or .loom/plugins/<name>/ with plugin.json)."));
      return;
    }
    for (const p of plugins) {
      const t = checkTrust(p.source, p.name, p.dir);
      let manifest: Record<string, string> = {};
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(p.dir, "plugin.json"), "utf8"));
      } catch {
        /* malformed manifest */
      }
      const status =
        t.status === "trusted" ? green("trusted") : t.status === "changed" ? red("CHANGED (disabled)") : yellow("untrusted");
      console.log(`${status.padEnd(22)} ${p.name} [${p.source}] ${dim(`v${manifest.version ?? "?"} — ${manifest.description ?? ""}`)}`);
      if (t.status !== "trusted") console.log(dim(`    → enable with: loom plugin trust ${p.name}`));
    }
    return;
  }
  const matches = plugins.filter((p) => !name || p.name === name);
  if (matches.length === 0) {
    console.error(red(`No plugin named "${name}".`));
    process.exit(1);
  }
  for (const p of matches) {
    if (op === "trust") {
      const rec = trust(p.source, p.name, p.dir);
      console.log(green(`trusted ${p.name} [${p.source}] fingerprint ${rec.fingerprint.slice(0, 16)}…`));
    } else {
      console.log(untrust(p.source, p.name) ? `untrusted ${p.name} [${p.source}]` : red(`No trust record for ${p.name}`));
    }
  }
}

// ---------------- subcommand: eval ----------------

async function cmdEval(args: string[]): Promise<void> {
  const dir = args.find((a) => !a.startsWith("--")) ?? "benchmarks/samples";
  if (!fs.existsSync(dir)) {
    console.error(red(`Eval tasks dir not found: ${dir}`));
    process.exit(1);
  }
  const resolved = resolveModel(undefined);
  console.log(bold(`loom eval — ${path.resolve(dir)}`));
  console.log(dim(`model: ${resolved.spec.id} (${resolved.spec.api})`));
  const results = await runEval(dir, {
    adapter: resolved.adapter,
    // memory tool excluded on purpose: benchmark runs must not write facts
    // into the user's cross-session memory.
    allToolDefs: BASE_TOOLS.filter((d) => d.name !== "memory"),
    pruneBytes: 30_000,
    compactThresholdTokens: 50_000,
    maxSteps: 60,
    sandboxFor: (workspace, sessionDir) =>
      createSandbox(workspace, [path.join(sessionDir, "artifacts")]),
  });
  console.log("");
  let passed = 0;
  for (const r of results) {
    if (r.pass) passed++;
    console.log(
      `${r.pass ? green("PASS") : red("FAIL")}  ${r.task.padEnd(16)} ` +
        dim(`${r.steps} steps | ${r.inputTokens}/${r.outputTokens} tok in/out | ${(r.durationMs / 1000).toFixed(1)}s`),
    );
    if (!r.pass) console.log(dim(`      verify: ${preview(r.verifyOutput, 140)}`));
    console.log(dim(`      session: ${r.sessionDir}`));
  }
  console.log(`\n${passed}/${results.length} passed — results: ${path.join(dir, "eval-results.jsonl")}`);
  process.exit(passed === results.length ? 0 : 1);
}

// ---------------- main ----------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "replay") return cmdReplay(args.slice(1));
  if (args[0] === "plugin") return cmdPlugin(args.slice(1));
  if (args[0] === "eval") return cmdEval(args.slice(1));
  if (["-h", "--help", "help"].includes(args[0] ?? "")) return printHelp();

  let print = false;
  let promptArgs: string[] = [];
  let model: string | undefined;
  let mode: PermMode | undefined;
  let resumeId: string | undefined;
  let maxSteps: number | undefined;
  let compactThreshold: number | undefined;
  let sandboxFlag: boolean | undefined;

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
      case "--sandbox":
        sandboxFlag = true;
        break;
      case "--no-sandbox":
        sandboxFlag = false;
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

  // ---- plugins (fingerprint trust gate; untrusted are skipped with a warning)
  const loadedPlugins: LoadedPlugin[] = loadAllPlugins(cwd, warn);
  const hooksConfig = mergeHookConfigs(
    config.hooks ?? {},
    loadedPlugins.reduce<HooksConfig>((acc, p) => mergeHookConfigs(acc, p.hooks), {}),
  );

  // ---- skills (user/project + trusted plugins; non-plugin wins on collision)
  const skillByName = new Map<string, Skill>();
  for (const s of [
    ...loadedPlugins.flatMap((p) => p.skills),
    ...discoverSkills(cwd),
  ]) {
    skillByName.set(s.name, s);
  }
  const skills = [...skillByName.values()];
  const catalog = skillsCatalog(skills);
  const skillDefs = skills.length ? [makeSkillTool(skills)] : [];

  // ---- slash commands (project > user > plugin)
  const commands = discoverCommands(
    cwd,
    loadedPlugins.flatMap((p) => p.commands),
  );
  const commandByName = new Map(commands.map((c) => [c.name, c]));

  // ---- MCP servers
  const mcpDefs: ToolDef[] = [];
  const mcpClients: McpClient[] = [];
  const mcpServers = ((config as LoomConfig & { mcp?: { servers?: Record<string, McpServerConfig> }; mcpServers?: Record<string, McpServerConfig> })
    .mcp?.servers ?? (config as LoomConfig & { mcpServers?: Record<string, McpServerConfig> }).mcpServers ?? {}) as Record<string, McpServerConfig>;
  for (const [name, cfg] of Object.entries(mcpServers)) {
    try {
      const client = await McpClient.connect(name, cfg);
      const tools = await client.listTools();
      mcpDefs.push(...bridgeAllTools(client, tools));
      mcpClients.push(client);
      console.error(dim(`[loom] MCP "${name}": ${tools.length} tool(s) connected`));
    } catch (e) {
      warn(`MCP server "${name}" failed to connect, skipping: ${(e as Error).message}`);
    }
  }
  if (mcpClients.length) {
    process.on("exit", () => {
      for (const c of mcpClients) c.close();
    });
  }

  // ---- session
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
  const hooks = new HookRunner(hooksConfig, cwd, (m) => console.error(yellow(`[hook] ${m}`)));

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
  const allDefs: ToolDef[] = [...BASE_TOOLS, ...skillDefs, ...mcpDefs];
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

  const agentsMd = loadAgentInstructions(cwd);
  const systemText = composeSystemPrompt({
    agents: agentsMd,
    subagents: true,
    memory: true,
    memoryText: loadMemory(),
    skills: catalog,
  });
  const threshold =
    compactThreshold ??
    config.context?.compactThresholdTokens ??
    Math.min(60_000, Math.floor(spec.contextWindow / 2));
  const pruneBytes = config.context?.pruneBytes ?? 30_000;
  const stepBudget = maxSteps ?? config.maxSteps ?? 200;

  const buildDefs = (m: PermMode) => [...allDefs, ...(m === "plan" ? [exitPlanTool] : [])];

  // ---- sandbox policy: forced > off > auto (auto = on in bypass mode)
  const sandbox: Sandbox | null = createSandbox(cwd, [path.join(log.sessionDir, "artifacts")]);
  let sandboxOn = false;
  if (sandboxFlag === true) {
    if (!sandbox) {
      console.error(red("No OS sandbox available on this platform (seatbelt/bwrap missing) — --sandbox refused."));
      process.exit(1);
    }
    sandboxOn = true;
  } else if (sandboxFlag === false) {
    if (mode === "bypassPermissions") {
      console.error(yellow("WARNING: bypassPermissions WITHOUT sandbox — every command runs unrestricted."));
    }
  } else if (mode === "bypassPermissions") {
    sandboxOn = !!sandbox;
    if (!sandbox) console.error(yellow("WARNING: bypassPermissions and no OS sandbox available — unrestricted execution."));
  }
  if (sandboxOn && sandbox) {
    ctx.sandboxWrap = (cmd) => sandbox.wrap(cmd);
  }

  const hookAsk = async (tool: string, input: Record<string, unknown>) => {
    const h = await hooks.run("PermissionRequest", { tool, input });
    return { decision: h.decision as "allow" | "deny" | "ask" | undefined, reason: h.reason };
  };

  const perm = new PermissionEngine(mode, rules, undefined, { onAsk: hookAsk });
  const ctxManager = new ContextManager({
    log,
    artifacts,
    summarizer: makeAdapterSummarizer(resolved.adapter),
    thresholdTokens: threshold,
  });
  ctx.spawnSubagent = makeSubagentSpawner({
    parentSessionDir: log.sessionDir,
    cwd,
    adapter: resolved.adapter,
    allToolDefs: [...BASE_TOOLS, ...skillDefs],
    perm,
    hooks,
    pruneBytes,
    compactThresholdTokens: Math.min(threshold, 50_000),
    maxSteps: 40,
    extraSystem: catalog,
  });

  if (print) {
    const prompt = promptArgs.join(" ").trim();
    if (!prompt) {
      console.error(red("loom -p requires a prompt."));
      process.exit(2);
    }
    const registry = new ToolRegistry(buildDefs(mode), ctx, pruneBytes);
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
      ctxManager,
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
  perm.setAskIO({ ask }); // wire interactive ask now that rl exists

  console.log(bold("Loom") + dim(` v0.2.0 — small core, everything logged, everything composable`));
  console.log(
    dim(
      `session ${log.sessionId} | model ${spec.id} (${spec.api}) | mode ${perm.getMode()}` +
        ` | sandbox ${sandboxOn && sandbox ? sandbox.kind : "off"} | threshold ~${threshold} tok`,
    ),
  );
  if (skills.length) console.log(dim(`skills: ${skills.length} loaded`));
  if (commands.length) console.log(dim(`commands: /${commands.map((c) => c.name).join(" /")} available`));
  console.log(dim(`log ${log.file}`));
  console.log(dim(`type /help for commands`));

  const runOneTurn = async (text: string) => {
    abort = new AbortController();
    const registry = new ToolRegistry(buildDefs(perm.getMode()), ctx, pruneBytes);
    const io: LoopIO = {
      onText: (d) => process.stdout.write(d),
      onToolCall: (call) => process.stdout.write("\n" + cyan(`⏺ ${call.name}(${summarizeInput(call.input)})`)),
      onToolResult: (r) =>
        process.stdout.write("\n" + dim(r.isError ? red("  ✗ " + preview(r.content)) : "  " + preview(r.content))),
      onNotice: (m) => process.stdout.write("\n" + yellow(`[loom] ${m}`)),
      onTurnEnd: (info) => {
        if (info.usage) {
          console.log(
            dim(`\n  [${info.steps} steps | in:${info.usage.input ?? "?"} out:${info.usage.output ?? "?"} tokens]`),
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
      await runTurn(deps, text);
    } catch (e) {
      console.error(red(`\n[loom] turn failed: ${(e as Error).message}`));
    }
    abort = null;
    process.stdout.write("\n");
  };

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
    if (line === "/plugins") {
      for (const p of loadedPlugins) {
        const status = p.status === "trusted" ? green("trusted") : p.status === "changed" ? red("CHANGED") : yellow("untrusted");
        console.log(`${status.padEnd(12)} ${p.name} [${p.source}] ${dim(p.version ?? "")}`);
      }
      if (loadedPlugins.length === 0) console.log(dim("no plugins found"));
      continue;
    }
    if (line === "/skills") {
      for (const s of skills) console.log(`${s.name.padEnd(24)} ${dim(preview(s.description, 90))}`);
      if (skills.length === 0) console.log(dim("no skills installed (~/.loom/skills/<name>/SKILL.md)"));
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
      // user/plugin slash command: /name args...
      const [name, ...rest] = line.slice(1).split(/\s+/);
      const cmd: SlashCommand | undefined = commandByName.get(name);
      if (!cmd) {
        console.error(dim(`unknown command /${name} — /help`));
        continue;
      }
      console.log(dim(`running /${name} (${cmd.source})`));
      await runOneTurn(expandCommand(cmd, rest.join(" ")));
      continue;
    }

    if (perm.getMode() === "plan") ctx.planGate = { approve: approvePlan };
    await runOneTurn(line);
  }
  rl.close();
}

main().catch((e) => {
  console.error(red(`[loom] ${e instanceof Error ? e.message : String(e)}`));
  process.exit(1);
});
