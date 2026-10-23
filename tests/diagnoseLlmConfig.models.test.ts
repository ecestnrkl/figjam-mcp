import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { chatJsonMock } = vi.hoisted(() => ({ chatJsonMock: vi.fn() }));
vi.mock("../src/lib/llmClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/llmClient.js")>()),
  chatJson: chatJsonMock,
}));
const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");

beforeEach(() => {
  for (const name of ["LLM_MODEL_PRESET", "LLM_TEXT_MODELS", "LLM_FAST_TEXT_MODELS", "LLM_VISION_MODELS", "LLM_TEXT_MODEL", "LLM_VISION_MODEL"]) {
    vi.stubEnv(name, "");
  }
  chatJsonMock.mockReset().mockImplementation(async (models, _messages, options) => {
    options.onModelUsed(models[0]);
    if (options.schemaName === "diagnose_vision_json") return { dominantColor: "blue" };
    return { result: options.schemaName === "diagnose_text_json" ? 42 : 63 };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("diagnostic model summary", () => {
  it("keeps the preset without model overrides", async () => {
    expect((await diagnoseLlmConfig()).summary).toBe("LLM configuration OK (student-free).");
  });

  it("names the shared overridden model while preserving the structured preset", async () => {
    for (const name of ["LLM_TEXT_MODELS", "LLM_FAST_TEXT_MODELS", "LLM_VISION_MODELS"]) vi.stubEnv(name, "openai/gpt-4.1-mini");
    const result = await diagnoseLlmConfig();
    expect(result.summary).toBe("LLM configuration OK (openai/gpt-4.1-mini).");
    expect(result.preset).toBe("student-free");
    expect(chatJsonMock.mock.calls.map(([models]) => models)).toEqual(Array(3).fill(["openai/gpt-4.1-mini"]));
  });

  it("names different vision and text roles without repeating fast text", async () => {
    vi.stubEnv("LLM_VISION_MODELS", "vision-a");
    vi.stubEnv("LLM_TEXT_MODELS", "text-a");
    expect((await diagnoseLlmConfig()).summary).toBe("LLM configuration OK (vision: vision-a; text: text-a).");
  });

  it.each([
    ["LLM_TEXT_MODELS", "vision: openrouter/free; text: custom"],
    ["LLM_VISION_MODELS", "vision: custom; text: openrouter/free"],
    ["LLM_FAST_TEXT_MODELS", "vision: openrouter/free; text: openrouter/free; fast text: custom"],
    ["LLM_TEXT_MODEL", "vision: openrouter/free; text: custom"],
    ["LLM_VISION_MODEL", "vision: custom; text: openrouter/free"],
  ])("recognizes a lone %s override", async (name, roles) => {
    vi.stubEnv(name, "custom");
    expect((await diagnoseLlmConfig()).summary).toBe(`LLM configuration OK (${roles}).`);
  });

  it("names the models that answered after fallback, keeping configured candidate lists", async () => {
    vi.stubEnv("LLM_TEXT_MODELS", "unavailable, actual-text");
    vi.stubEnv("LLM_VISION_MODELS", "actual-vision");
    chatJsonMock.mockImplementation(async (models, _messages, options) => {
      const fallback = models[0] === "unavailable";
      if (fallback) options.onModelFailed("unavailable", "Provider unavailable");
      options.onModelUsed(fallback ? models[1] : models[0]);
      if (options.schemaName === "diagnose_vision_json") return { dominantColor: "blue" };
      return { result: options.schemaName === "diagnose_text_json" ? 42 : 63 };
    });
    const result = await diagnoseLlmConfig();
    expect(result.summary).toBe("LLM configuration OK (vision: actual-vision; text: actual-text)." +
      " Fallback: text_json used actual-text after unavailable failed; fast_text_json used actual-text after unavailable failed.");
    expect(result.textModels).toEqual(["unavailable", "actual-text"]);
  });
});
