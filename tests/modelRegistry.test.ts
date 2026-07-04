import { afterEach, describe, expect, it } from "vitest";
import { describeModelConfig, getModelsForRole } from "../src/lib/modelRegistry.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("modelRegistry", () => {
  it("uses the student-free preset by default", () => {
    delete process.env.LLM_MODEL_PRESET;
    delete process.env.LLM_VISION_MODEL;
    delete process.env.LLM_TEXT_MODEL;
    delete process.env.LLM_VISION_MODELS;
    delete process.env.LLM_TEXT_MODELS;

    const config = describeModelConfig();
    expect(config.preset).toBe("student-free");
    expect(config.visionModels[0]).toBe("google/gemma-4-26b-a4b-it:free");
    expect(config.textModels[0]).toBe("qwen/qwen3-next-80b-a3b-instruct:free");
    expect(config.providerRequireParameters).toBe(true);
  });

  it("keeps legacy single-model env vars as first-candidate overrides", () => {
    process.env.LLM_VISION_MODEL = "legacy-vision";
    process.env.LLM_TEXT_MODEL = "legacy-text";

    expect(getModelsForRole("vision")[0]).toBe("legacy-vision");
    expect(getModelsForRole("text")[0]).toBe("legacy-text");
  });

  it("reads comma-separated role model lists", () => {
    delete process.env.LLM_TEXT_MODEL;
    process.env.LLM_TEXT_MODELS = "model-a, model-b";

    expect(getModelsForRole("text").slice(0, 2)).toEqual(["model-a", "model-b"]);
  });
});
