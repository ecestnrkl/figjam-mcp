import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatJsonMock } = vi.hoisted(() => ({ chatJsonMock: vi.fn() }));

vi.mock("../src/lib/llmClient.js", () => ({
  chatJson: chatJsonMock,
  getFastTextModels: () => ["fast-model"],
  getTextModels: () => ["text-model"],
  getVisionModels: () => ["vision-model"],
}));

vi.mock("../src/lib/modelRegistry.js", () => ({
  describeModelConfig: () => ({
    preset: "student-free",
    visionModels: ["vision-model"],
    textModels: ["text-model"],
    fastTextModels: ["fast-model"],
    providerRequireParameters: true,
  }),
}));

const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");

beforeEach(() => {
  chatJsonMock.mockReset();
});

describe("diagnoseLlmConfig", () => {
  it("reports ok when text and vision checks pass", async () => {
    chatJsonMock.mockResolvedValue({ ok: true });

    const result = await diagnoseLlmConfig();

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.map((check) => check.name)).toEqual([
      "text_json",
      "fast_text_json",
      "vision_json",
    ]);
    expect(chatJsonMock.mock.calls[1]?.[0]).toEqual(["fast-model"]);
    expect(result.summary).toContain("OK");
  });

  it("reports failed checks without throwing", async () => {
    chatJsonMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("vision failed"));

    const result = await diagnoseLlmConfig();

    expect(result.ok).toBe(false);
    expect(result.checks[2]).toMatchObject({ name: "vision_json", ok: false });
    expect(result.summary).toContain("failing");
  });
});
