import { readBoolEnv } from "./env.js";

export type LlmRole = "vision" | "text" | "fastText";

export interface ModelConfig {
  preset: string;
  visionModels: string[];
  textModels: string[];
  fastTextModels: string[];
  providerRequireParameters: boolean;
}

interface RoleModelDefaults {
  visionModels: string[];
  textModels: string[];
  fastTextModels: string[];
}

const MODEL_PRESETS: Record<string, RoleModelDefaults> = {
  "student-free": {
    visionModels: ["google/gemma-4-26b-a4b-it:free", "openrouter/free"],
    textModels: [
      "qwen/qwen3-next-80b-a3b-instruct:free",
      "nvidia/nemotron-nano-9b-v2:free",
      "openrouter/free",
    ],
    fastTextModels: ["nvidia/nemotron-nano-9b-v2:free", "liquid/lfm-2.5-1.2b-instruct:free"],
  },
};

const DEFAULT_MODEL_PRESET = "student-free";

const SUPPORTED_MODEL_PRESETS = Object.keys(MODEL_PRESETS);

const LEGACY_VISION_MODEL_ENV = "LLM_VISION_MODEL";
const LEGACY_TEXT_MODEL_ENV = "LLM_TEXT_MODEL";

const MODEL_LIST_ENV = {
  vision: "LLM_VISION_MODELS",
  text: "LLM_TEXT_MODELS",
  fastText: "LLM_FAST_TEXT_MODELS",
} as const;

const PROVIDER_REQUIRE_PARAMETERS_ENV = "LLM_PROVIDER_REQUIRE_PARAMETERS";

const MODEL_PRESET_ENV = "LLM_MODEL_PRESET";

export function getModelConfig(): ModelConfig {
  const preset = readModelPreset();
  const defaults = MODEL_PRESETS[preset]!;

  return {
    preset,
    visionModels: withLegacyOverride(
      LEGACY_VISION_MODEL_ENV,
      readModelList(MODEL_LIST_ENV.vision, defaults.visionModels),
    ),
    textModels: withLegacyOverride(
      LEGACY_TEXT_MODEL_ENV,
      readModelList(MODEL_LIST_ENV.text, defaults.textModels),
    ),
    fastTextModels: readModelList(MODEL_LIST_ENV.fastText, defaults.fastTextModels),
    providerRequireParameters: readBoolEnv(PROVIDER_REQUIRE_PARAMETERS_ENV, true),
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

function readModelPreset(): string {
  const preset = process.env[MODEL_PRESET_ENV]?.trim() || DEFAULT_MODEL_PRESET;
  if (!MODEL_PRESETS[preset]) {
    throw new Error(
      `${MODEL_PRESET_ENV} must be one of: ${SUPPORTED_MODEL_PRESETS.join(", ")}`,
    );
  }
  return preset;
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
  return values.length > 0 ? unique(values) : [...fallback];
}

function withLegacyOverride(name: string, models: string[]): string[] {
  const legacy = process.env[name]?.trim();
  if (!legacy) {
    return models;
  }
  return unique([legacy, ...models]);
}

function unique(models: string[]): string[] {
  return [...new Set(models)];
}
