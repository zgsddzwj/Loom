/**
 * Model catalog + resolution.
 *
 * Keys are read ONLY from environment variables — never written to any
 * config file. Any OpenAI-compatible endpoint can be used generically via
 * LOOM_MODEL / LOOM_BASE_URL / LOOM_API_KEY (e.g. Ollama, vLLM, one-api).
 */

import type { ModelAdapter } from "../core/types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAICompatAdapter } from "./openai.js";

export interface ModelSpec {
  id: string;
  api: "anthropic" | "openai";
  baseUrl: string;
  envKeys: string[];
  contextWindow: number;
  maxOutput?: number;
}

export const MODEL_CATALOG: ModelSpec[] = [
  {
    id: "glm-4.7",
    api: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    envKeys: ["ZHIPU_API_KEY", "GLM_API_KEY", "LOOM_API_KEY"],
    contextWindow: 128_000,
  },
  {
    id: "deepseek-chat",
    api: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    envKeys: ["DEEPSEEK_API_KEY", "LOOM_API_KEY"],
    contextWindow: 128_000,
  },
  {
    id: "deepseek-reasoner",
    api: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    envKeys: ["DEEPSEEK_API_KEY", "LOOM_API_KEY"],
    contextWindow: 128_000,
  },
  {
    id: "claude-sonnet-4-5",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com",
    envKeys: ["ANTHROPIC_API_KEY", "LOOM_API_KEY"],
    contextWindow: 200_000,
    maxOutput: 16_384,
  },
  {
    id: "gpt-4o",
    api: "openai",
    baseUrl: "https://api.openai.com/v1",
    envKeys: ["OPENAI_API_KEY", "LOOM_API_KEY"],
    contextWindow: 128_000,
  },
  {
    id: "kimi-k2-turbo-preview",
    api: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    envKeys: ["MOONSHOT_API_KEY", "LOOM_API_KEY"],
    contextWindow: 128_000,
  },
];

export interface ResolvedModel {
  spec: ModelSpec;
  apiKey: string;
  adapter: ModelAdapter;
}

function firstKey(spec: ModelSpec, env: Record<string, string | undefined>): string | undefined {
  for (const k of spec.envKeys) if (env[k]) return env[k];
  return undefined;
}

export function resolveModel(
  requested: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedModel {
  let apiOverride: "anthropic" | "openai" | undefined;
  let id = requested ?? env.LOOM_MODEL;

  if (id && id.includes(":")) {
    const [prefix, ...rest] = id.split(":");
    if (prefix === "anthropic" || prefix === "openai") {
      apiOverride = prefix;
      id = rest.join(":");
    }
  }

  const catalogMatch = MODEL_CATALOG.find(
    (m) => (!id || m.id === id) && (!apiOverride || m.api === apiOverride),
  );

  let spec: ModelSpec | undefined;
  if (catalogMatch) {
    spec = { ...catalogMatch, baseUrl: env.LOOM_BASE_URL ?? catalogMatch.baseUrl };
  } else if (id) {
    // Unknown model id: treat as a generic endpoint (OpenAI-compatible by
    // default, or the explicit api prefix). Requires LOOM_API_KEY.
    spec = {
      id,
      api: apiOverride ?? "openai",
      baseUrl:
        env.LOOM_BASE_URL ??
        (apiOverride === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
      envKeys: ["LOOM_API_KEY"],
      contextWindow: env.LOOM_CONTEXT_WINDOW ? Number(env.LOOM_CONTEXT_WINDOW) : 128_000,
    };
  }

  if (!spec) {
    // No explicit model: pick the first catalog entry that has a key.
    spec = MODEL_CATALOG.find((m) => firstKey(m, env));
    if (!spec) {
      throw new Error(
        "No API key found. Set LOOM_MODEL + LOOM_API_KEY for a generic OpenAI-compatible endpoint, " +
          "or a provider key (ZHIPU_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / MOONSHOT_API_KEY).",
      );
    }
  }

  const apiKey = firstKey(spec, env);
  if (!apiKey) {
    throw new Error(
      `No API key for model "${spec.id}". Set one of: ${spec.envKeys.join(", ")}. ` +
        `(Keys are read from the environment only — Loom never stores them.)`,
    );
  }

  const adapter: ModelAdapter =
    spec.api === "anthropic"
      ? new AnthropicAdapter({ apiKey, model: spec.id, baseUrl: spec.baseUrl, maxTokens: spec.maxOutput })
      : new OpenAICompatAdapter({ apiKey, model: spec.id, baseUrl: spec.baseUrl, maxTokens: spec.maxOutput });

  return { spec, apiKey, adapter };
}
