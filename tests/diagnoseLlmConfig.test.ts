import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatJsonMock } = vi.hoisted(() => ({ chatJsonMock: vi.fn() }));

vi.mock("../src/lib/llmClient.js", () => ({
  chatJson: chatJsonMock,
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
    expect(result.checks).toHaveLength(2);
    expect(result.summary).toContain("OK");
  });

  it("reports failed checks without throwing", async () => {
    chatJsonMock
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("vision failed"));

    const result = await diagnoseLlmConfig();

    expect(result.ok).toBe(false);
    expect(result.checks[1]).toMatchObject({ name: "vision_json", ok: false });
    expect(result.summary).toContain("failing");
  });
});
