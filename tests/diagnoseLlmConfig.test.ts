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
    chatJsonMock
      .mockResolvedValueOnce({ result: 42 })
      .mockResolvedValueOnce({ result: 63 })
      .mockResolvedValueOnce({ dominantColor: "blue" });

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

    const visionMessages = chatJsonMock.mock.calls[2]?.[1] as Array<{
      content: Array<{ type: string; image_url?: { url: string } }>;
    }>;
    expect(visionMessages[0]?.content[1]?.image_url?.url).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("reports failed checks without throwing", async () => {
    chatJsonMock
      .mockResolvedValueOnce({ result: 42 })
      .mockResolvedValueOnce({ result: 63 })
      .mockRejectedValueOnce(new Error("vision failed"));

    const result = await diagnoseLlmConfig();

    expect(result.ok).toBe(false);
    expect(result.checks[2]).toMatchObject({ name: "vision_json", ok: false });
    expect(result.summary).toContain("failing");
  });

  it.each([{}, { ok: false }])(
    "rejects parseable JSON that does not answer the diagnostic challenges: %j",
    async (reply) => {
      chatJsonMock.mockResolvedValue(reply);

      const result = await diagnoseLlmConfig();

      expect(result.ok).toBe(false);
      expect(result.checks).toEqual([
        expect.objectContaining({ name: "text_json", ok: false }),
        expect.objectContaining({ name: "fast_text_json", ok: false }),
        expect.objectContaining({ name: "vision_json", ok: false }),
      ]);
      expect(result.checks[0]?.error).toContain("value 42");
    },
  );

  it.each([
    { result: "42" },
    { result: 42, extra: true },
  ])("rejects text replies that violate the advertised JSON schema: %j", async (reply) => {
    chatJsonMock
      .mockResolvedValueOnce(reply)
      .mockResolvedValueOnce({ result: 63 })
      .mockResolvedValueOnce({ dominantColor: "blue" });

    const result = await diagnoseLlmConfig();

    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: "text_json", ok: false });
    expect(result.checks[1]?.ok).toBe(true);
    expect(result.checks[2]?.ok).toBe(true);
  });

  it("fails vision when the model returns the wrong visual property", async () => {
    chatJsonMock
      .mockResolvedValueOnce({ result: 42 })
      .mockResolvedValueOnce({ result: 63 })
      .mockResolvedValueOnce({ dominantColor: "red" });

    const result = await diagnoseLlmConfig();

    expect(result.ok).toBe(false);
    expect(result.checks[0]?.ok).toBe(true);
    expect(result.checks[1]?.ok).toBe(true);
    expect(result.checks[2]).toMatchObject({
      name: "vision_json",
      ok: false,
      error: expect.stringContaining("expected dominant color blue"),
    });
  });

  it.each([
    { dominantColor: "BLUE" },
    { dominantColor: "purple" },
    { dominantColor: "blue", extra: true },
  ])("rejects vision replies that violate the advertised JSON schema: %j", async (reply) => {
    chatJsonMock
      .mockResolvedValueOnce({ result: 42 })
      .mockResolvedValueOnce({ result: 63 })
      .mockResolvedValueOnce(reply);

    const result = await diagnoseLlmConfig();

    expect(result.ok).toBe(false);
    expect(result.checks[2]).toMatchObject({ name: "vision_json", ok: false });
  });
});
