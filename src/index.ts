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
export { buildSystemPrompt, buildBaseSystemPrompt } from "./sysprompt.js";
export { loadConfig, loomHome, sessionsRoot, type LoomConfig } from "./config.js";
export { runTurn, type LoopIO, type LoopDeps, type TurnResult } from "./core/loop.js";
