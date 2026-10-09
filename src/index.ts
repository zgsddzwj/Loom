/** Loom public API (SDK surface). */

export type {
  ModelAdapter,
  ModelRequest,
  ProjectedMessage,
  StreamEvent,
  StopReason,
  ToolCall,
  ToolResult,
  TokenUsage,
  ToolSchema,
} from "./core/types.js";

export { EventLog, LOOM_VERSION, type LoomEvent, type LoomEventInput } from "./log/eventlog.js";
export { project, compactionIntro, type Projection } from "./log/projector.js";

export { ArtifactStore } from "./context/artifacts.js";
export { pruneToolResult } from "./context/pruner.js";
export { estimateTokens, estimateRequestTokens, estimateRequest } from "./context/tokens.js";
export { ContextManager, makeAdapterSummarizer, type Summarizer } from "./context/manager.js";

export { AnthropicAdapter } from "./providers/anthropic.js";
export { OpenAICompatAdapter } from "./providers/openai.js";
export { resolveModel, MODEL_CATALOG, type ModelSpec, type ResolvedModel } from "./providers/catalog.js";

export { ReadState } from "./tools/readstate.js";
export { readTool, editTool, writeTool } from "./tools/files.js";
export { bashTool, bashOutputTool, Job } from "./tools/bash.js";
export { globTool, grepTool, globToRegex, walkFiles, grepWithJs } from "./tools/search.js";
export { todoTool, type TodoItem } from "./tools/todo.js";
export { recallTool } from "./tools/recall.js";
export { exitPlanTool } from "./tools/plan.js";
export { ToolRegistry, type ToolDef, type ToolContext, type ToolIO, type PlanGate } from "./tools/registry.js";
export { ToolError } from "./tools/errors.js";

export { PermissionEngine, parseRuleSpec, type PermMode, type PermRule, type PermDecision } from "./perm/engine.js";
export { HookRunner, HOOK_EVENTS, type HookEvent, type HooksConfig } from "./hooks/runner.js";
export { loadAgentInstructions } from "./memory/agentsmd.js";
export { memoryTool } from "./memory/memoryTool.js";
export { loadMemory, appendMemory, memoryFile, MEMORY_BUDGET } from "./memory/store.js";
export { buildSystemPrompt, buildBaseSystemPrompt, composeSystemPrompt } from "./sysprompt.js";
export { loadConfig, loomHome, sessionsRoot, type LoomConfig } from "./config.js";
export { runTurn, type LoopIO, type LoopDeps, type TurnResult } from "./core/loop.js";

// ---- v0.2.0 (M3) ----
export { discoverSkills, skillsCatalog, type Skill } from "./skills/loader.js";
export { makeSkillTool } from "./skills/skillTool.js";
export { SUBAGENT_PROFILES, resolveProfile, type SubagentProfile } from "./subagents/profiles.js";
export { makeSubagentSpawner } from "./subagents/spawn.js";
export { taskTool } from "./tools/task.js";
export { McpClient, type McpServerConfig, type McpToolInfo } from "./mcp/client.js";
export { bridgeTool, bridgeAllTools } from "./mcp/bridge.js";

// ---- v0.2.0 (M4) ----
export { createSandbox, detectSandbox, type Sandbox, type SandboxKind } from "./sandbox/sandbox.js";
export { discoverPlugins, loadAllPlugins, loadPlugin, type LoadedPlugin, type PluginOnDisk } from "./plugins/loader.js";
export { checkTrust, trust, untrust, fingerprintDir } from "./plugins/trust.js";
export { discoverCommands, expandCommand, parseCommandFile, type SlashCommand } from "./commands/loader.js";
export { runEval, type EvalResult, type EvalDeps } from "./eval/runner.js";
