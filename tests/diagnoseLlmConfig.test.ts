import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("diagnoseLlmConfig", () => {
  it("does not start diagnostics after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(diagnoseLlmConfig({ signal: controller.signal })).rejects.toBeDefined();
    expect(chatJsonMock).not.toHaveBeenCalled();
  });

  it("stops after an in-flight provider call is cancelled", async () => {
    const controller = new AbortController();
    chatJsonMock.mockImplementationOnce(async (_models, _messages, options) => {
      controller.abort();
      expect(options.signal.aborted).toBe(true);
      throw options.signal.reason;
    });
    await expect(diagnoseLlmConfig({ signal: controller.signal })).rejects.toBeDefined();
    expect(chatJsonMock).toHaveBeenCalledTimes(1);
  });

  it("starts all checks before any reply and keeps the result order", async () => {
    const replies: Array<(reply: unknown) => void> = [];
    chatJsonMock.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));

    const running = diagnoseLlmConfig();
    expect(chatJsonMock).toHaveBeenCalledTimes(3);
    replies[2]!({ dominantColor: "blue" });
    replies[1]!({ result: 63 });
    replies[0]!({ result: 42 });
    const result = await running;

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual(["text_json", "fast_text_json", "vision_json"]);
  });

  it("cancels every in-flight check", async () => {
    const controller = new AbortController();
    chatJsonMock.mockImplementation((_models, _messages, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));

    const running = diagnoseLlmConfig({ signal: controller.signal });
    expect(chatJsonMock).toHaveBeenCalledTimes(3);
    controller.abort(new Error("client cancelled"));

    await expect(running).rejects.toThrow("client cancelled");
    expect(chatJsonMock.mock.calls.every(([, , options]) => options.signal.aborted)).toBe(true);
  });

  it("answers within 45 s when the provider hangs", async () => {
    vi.useFakeTimers();
    chatJsonMock.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const running = diagnoseLlmConfig().finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(44_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => check.error)).toEqual(Array(3).fill("Check did not finish within 45 s."));
    expect(chatJsonMock.mock.calls.every(([, , options]) => options.signal.aborted)).toBe(true);
  });

  it("uses the configured answer and vision output budgets", async () => {
    vi.stubEnv("LLM_ANSWER_MAX_OUTPUT_TOKENS", "1500");
    vi.stubEnv("LLM_VISION_MAX_OUTPUT_TOKENS", "3000");
    vi.resetModules();
    const { diagnoseLlmConfig: configuredDiagnose } = await import("../src/tools/diagnoseLlmConfig.js");
    chatJsonMock
      .mockResolvedValueOnce({ result: 42 })
      .mockResolvedValueOnce({ result: 63 })
      .mockResolvedValueOnce({ dominantColor: "blue" });

    await configuredDiagnose();

    expect(chatJsonMock.mock.calls.map(([, , options]) => options.maxOutputTokens)).toEqual([1500, 1500, 3000]);
  });

  it("reports ok when text and vision checks pass", async () => {
    vi.stubEnv("LLM_REQUEST_TIMEOUT_MS", "");
    vi.stubEnv("LLM_ANSWER_REQUEST_TIMEOUT_MS", "");
    vi.stubEnv("LLM_VISION_REQUEST_TIMEOUT_MS", "60000");
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
    expect(chatJsonMock.mock.calls.map(([, , options]) => options.requestTimeoutMs)).toEqual([40000, 40000, 60000]);
    expect(chatJsonMock.mock.calls.map(([, , options]) => options.timeoutSetting)).toEqual([
      "LLM_ANSWER_REQUEST_TIMEOUT_MS", "LLM_ANSWER_REQUEST_TIMEOUT_MS", "LLM_VISION_REQUEST_TIMEOUT_MS",
    ]);
    expect(chatJsonMock.mock.calls.map(([, , options]) => options.maxOutputTokens)).toEqual([2048, 2048, 4096]);
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

  it("names every tried candidate and reports a fallback that answers", async () => {
    const providerMessage = "Provider returned error, code 404, provider Nvidia";
    chatJsonMock.mockImplementation(async (models: string[], _messages, options) => {
      if (models[0] === "text-model") {
        options.onRequest?.("text-model");
        options.onModelFailed?.("text-model", providerMessage);
        options.onRequest?.("router/free");
        options.onModelUsed?.("router/free");
        return { result: 42 };
      }
      options.onRequest?.(models[0]);
      options.onModelUsed?.(models[0]);
      return models[0] === "fast-model" ? { result: 63 } : { dominantColor: "blue" };
    });

    const result = await diagnoseLlmConfig();

    expect(result.ok).toBe(true);
    expect(result.checks[0]).toEqual({ name: "text_json", ok: true, modelUsed: "router/free", attempts: [
      { model: "text-model", ok: false, error: providerMessage }, { model: "router/free", ok: true }] });
    expect(result.checks[1]?.attempts).toEqual([{ model: "fast-model", ok: true }]);
    expect(result.summary).toBe("LLM configuration OK (student-free). Fallback: text_json used router/free after text-model failed.");
  });

  it("reports a router retry apart from a fallback after both router attempts failed", async () => {
    chatJsonMock.mockImplementation(async (models: string[], _messages, options) => {
      if (models[0] === "text-model") {
        options.onModelFailed?.("openrouter/free", "Provider returned error");
        options.onModelUsed?.("openrouter/free");
        return { result: 42 };
      }
      if (models[0] === "fast-model") {
        options.onModelFailed?.("openrouter/free", "Provider returned error");
        options.onModelFailed?.("openrouter/free", "Provider returned error");
        options.onModelUsed?.("fast-model");
        return { result: 63 };
      }
      options.onModelUsed?.(models[0]);
      return { dominantColor: "blue" };
    });

    const result = await diagnoseLlmConfig();

    expect(result.checks[1]?.attempts?.map((attempt) => attempt.model)).toEqual(["openrouter/free", "openrouter/free", "fast-model"]);
    expect(result.summary).toBe("LLM configuration OK (student-free). Retry: text_json passed on the second openrouter/free attempt."
      + " Fallback: fast_text_json used fast-model after openrouter/free failed.");
  });

  it("names each failed candidate with its error", async () => {
    chatJsonMock.mockImplementation(async (models: string[], _messages, options) => {
      if (models[0] === "text-model") {
        options.onRequest?.("text-model");
        options.onModelFailed?.("text-model", "Provider returned error, code 404, provider Nvidia");
        options.onRequest?.("router/free");
        options.onModelFailed?.("router/free", "Provider returned error, code 404, provider Nvidia");
        throw new Error("LLM request failed (HTTP 404). Check provider availability and configuration.");
      }
      if (models[0] === "fast-model") {
        // The check deadline or a cancellation ends a request without a reported failure.
        options.onRequest?.("fast-model");
        throw new Error("Check did not finish within 45 s.");
      }
      options.onModelUsed?.(models[0]);
      return { dominantColor: "red" };
    });

    const result = await diagnoseLlmConfig();

    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ ok: false, error: "text-model: Provider returned error, code 404, provider Nvidia; "
      + "router/free: Provider returned error, code 404, provider Nvidia" });
    expect(result.checks[0]?.attempts?.map((attempt) => attempt.model)).toEqual(["text-model", "router/free"]);
    expect(result.checks[1]).toMatchObject({ ok: false, error: "fast-model: Check did not finish within 45 s.",
      attempts: [{ model: "fast-model", ok: false, error: "Check did not finish within 45 s." }] });
    expect(result.checks[2]).toMatchObject({ ok: false, modelUsed: "vision-model",
      error: expect.stringMatching(/^vision-model: Vision diagnostic failed: expected dominant color blue/) });
    expect(result.summary).toBe("LLM configuration has 3 failing check(s).");
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
