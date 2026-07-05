import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeModelConfig, getModelsForRole } from "../src/lib/modelRegistry.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  clearModelEnv();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("modelRegistry", () => {
  it("uses the student-free preset by default", () => {
    const config = describeModelConfig();
    expect(config.preset).toBe("student-free");
    expect(config.visionModels[0]).toBe("google/gemma-4-26b-a4b-it:free");
    expect(config.textModels[0]).toBe("qwen/qwen3-next-80b-a3b-instruct:free");
    expect(config.fastTextModels[0]).toBe("nvidia/nemotron-nano-9b-v2:free");
    expect(config.providerRequireParameters).toBe(true);
  });

  it("rejects unknown model presets", () => {
    process.env.LLM_MODEL_PRESET = "unknown";

    expect(() => describeModelConfig()).toThrow(/LLM_MODEL_PRESET must be one of: student-free/);
  });

  it("reads the OpenRouter provider parameter flag", () => {
    process.env.LLM_PROVIDER_REQUIRE_PARAMETERS = "false";

    expect(describeModelConfig().providerRequireParameters).toBe(false);
  });

  it("keeps legacy single-model env vars as first-candidate overrides", () => {
    process.env.LLM_VISION_MODELS = "legacy-vision, fallback-vision";
    process.env.LLM_TEXT_MODELS = "legacy-text, fallback-text";
    process.env.LLM_VISION_MODEL = "legacy-vision";
    process.env.LLM_TEXT_MODEL = "legacy-text";

    expect(getModelsForRole("vision")).toEqual(["legacy-vision", "fallback-vision"]);
    expect(getModelsForRole("text")).toEqual(["legacy-text", "fallback-text"]);
  });

  it("reads and normalizes comma-separated role model lists", () => {
    process.env.LLM_TEXT_MODELS = ", ,";
    expect(getModelsForRole("text")[0]).toBe("qwen/qwen3-next-80b-a3b-instruct:free");

    process.env.LLM_TEXT_MODELS = "model-a, , model-b, model-a";
    process.env.LLM_FAST_TEXT_MODELS = "fast-a, fast-b";

    expect(getModelsForRole("text")).toEqual(["model-a", "model-b"]);
    expect(getModelsForRole("fastText")).toEqual(["fast-a", "fast-b"]);
  });
});

function clearModelEnv(): void {
  delete process.env.LLM_MODEL_PRESET;
  delete process.env.LLM_PROVIDER_REQUIRE_PARAMETERS;
  delete process.env.LLM_VISION_MODEL;
  delete process.env.LLM_TEXT_MODEL;
  delete process.env.LLM_VISION_MODELS;
  delete process.env.LLM_TEXT_MODELS;
  delete process.env.LLM_FAST_TEXT_MODELS;
}
