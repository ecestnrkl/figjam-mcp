import { readBoolEnv } from "./env.js";

export type LlmRole = "vision" | "text" | "fastText";

export interface ModelConfig {
  preset: string;
  visionModels: string[];
  textModels: string[];
  fastTextModels: string[];
  providerRequireParameters: boolean;
}

const STUDENT_FREE_MODELS = {
  visionModels: ["google/gemma-4-26b-a4b-it:free", "openrouter/free"],
  textModels: [
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "nvidia/nemotron-nano-9b-v2:free",
    "openrouter/free",
  ],
  fastTextModels: ["nvidia/nemotron-nano-9b-v2:free", "liquid/lfm-2.5-1.2b-instruct:free"],
};

export function getModelConfig(): ModelConfig {
  const preset = process.env.LLM_MODEL_PRESET?.trim() || "student-free";
  const defaults = preset === "student-free" ? STUDENT_FREE_MODELS : STUDENT_FREE_MODELS;

  return {
    preset,
    visionModels: withLegacyOverride(
      "LLM_VISION_MODEL",
      readModelList("LLM_VISION_MODELS", defaults.visionModels),
    ),
    textModels: withLegacyOverride(
      "LLM_TEXT_MODEL",
      readModelList("LLM_TEXT_MODELS", defaults.textModels),
    ),
    fastTextModels: readModelList("LLM_FAST_TEXT_MODELS", defaults.fastTextModels),
    providerRequireParameters: readBoolEnv("LLM_PROVIDER_REQUIRE_PARAMETERS", true),
  };
}

export function getModelsForRole(role: LlmRole): string[] {
  const config = getModelConfig();
  if (role === "vision") {
    return config.visionModels;
  }
  if (role === "fastText") {
    return config.fastTextModels;
  }
  return config.textModels;
}

export function getModelConfigSignature(): string {
  const config = getModelConfig();
  return [
    config.preset,
    `vision=${config.visionModels.join(",")}`,
    `text=${config.textModels.join(",")}`,
    `fast=${config.fastTextModels.join(",")}`,
    `require=${config.providerRequireParameters}`,
  ].join("|");
}

export function describeModelConfig(): ModelConfig {
  return getModelConfig();
}

function readModelList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return [...fallback];
  }
  const values = raw
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return values.length > 0 ? values : [...fallback];
}

function withLegacyOverride(name: string, models: string[]): string[] {
  const legacy = process.env[name]?.trim();
  if (!legacy) {
    return models;
  }
  return [legacy, ...models.filter((model) => model !== legacy)];
}
