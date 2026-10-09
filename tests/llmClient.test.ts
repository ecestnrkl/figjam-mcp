import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * These tests exercise chatJson against a stubbed OpenAI client. The focus is
 * the failure mode where an OpenAI-compatible router (OpenRouter's free tier)
 * reports an error inside a 200 OK body with NO `choices` array — which used to
 * crash with "Cannot read properties of undefined (reading '0')".
 */

// Hoisted so the vi.mock factory (which is hoisted above module init) can see it.
const { createMock, constructorMock } = vi.hoisted(() => ({ createMock: vi.fn(), constructorMock: vi.fn() }));

vi.mock("openai", async (importActual) => {
  const actual = await importActual<typeof import("openai")>();
  const Real = actual.default;
  // Subclass-ish stub: `new OpenAI()` yields our controllable create(), while
  // the static error classes used by instanceof checks are preserved.
  class MockOpenAI {
    chat = { completions: { create: createMock } };
    constructor(opts?: unknown) { constructorMock(opts); }
    static RateLimitError = Real.RateLimitError;
    static APIError = Real.APIError;
    static APIConnectionTimeoutError = Real.APIConnectionTimeoutError;
  }
  return { default: MockOpenAI };
});

process.env.LLM_BASE_URL = "http://test.local/v1";
process.env.LLM_API_KEY = "test-key";

const { chatJson } = await import("../src/lib/llmClient.js");

const MESSAGES = [{ role: "user" as const, content: "hi" }];

/** A well-formed completion carrying `content` as its first choice. */
function okCompletion(content: string, finishReason = "stop") {
  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

beforeEach(() => {
  createMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("chatJson", () => {
  it("detects missing configuration without making any provider request", async () => {
    const { validateLlmConfiguration } = await import("../src/lib/llmClient.js");
    const previous = process.env.LLM_API_KEY;
    try {
      delete process.env.LLM_API_KEY;
      expect(() => validateLlmConfiguration()).toThrow(expect.objectContaining({ name: "LLMConfigurationError" }));
      await expect(chatJson("test-model", MESSAGES)).rejects.toMatchObject({ name: "LLMConfigurationError" });
      expect(createMock).not.toHaveBeenCalled();
    } finally { if (previous === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = previous; }
  });

  it("keeps provider timeouts distinguishable from other failures", async () => {
    const error = new Error("Private provider details"); error.name = "APIConnectionTimeoutError";
    createMock.mockRejectedValueOnce(error);
    const pending = chatJson("test-model", MESSAGES);
    await expect(pending).rejects.toMatchObject({ name: "LlmTimeoutError" });
    await expect(pending).rejects.not.toThrow(/Private provider details/);
  });
  it("parses a normal completion", async () => {
    createMock.mockResolvedValueOnce(okCompletion('{"answer":42}'));
    await expect(chatJson("test-model", MESSAGES)).resolves.toEqual({ answer: 42 });
  });

  it("reports actual attempts and provider usage including invalid JSON responses", async () => {
    const onRequest = vi.fn(); const onUsage = vi.fn();
    createMock.mockResolvedValueOnce({ ...okCompletion("invalid"), usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
      .mockResolvedValueOnce({ ...okCompletion('{"ok":true}'), usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
    await chatJson(["bad", "good"], MESSAGES, { onRequest, onUsage });
    expect(onRequest.mock.calls).toEqual([["bad"], ["good"]]);
    expect(onUsage.mock.calls.map(call => call[0].totalTokens)).toEqual([12, 14]);
  });

  it("rebuilds the provider client when its configured endpoint changes", async () => {
    createMock.mockResolvedValue(okCompletion('{"ok":true}'));
    await chatJson("test-model", MESSAGES);
    const before = constructorMock.mock.calls.length;
    const previous = process.env.LLM_BASE_URL;
    try {
      process.env.LLM_BASE_URL = "http://another-provider.local/v1";
      await chatJson("test-model", MESSAGES);
      expect(constructorMock).toHaveBeenCalledTimes(before + 1);
      expect(constructorMock.mock.calls.at(-1)?.[0].baseURL).toBe(process.env.LLM_BASE_URL);
    } finally { process.env.LLM_BASE_URL = previous; }
  });

  it("forwards caller cancellation and stops before trying another model", async () => {
    const controller = new AbortController();
    createMock.mockImplementationOnce(
      (_params: unknown, requestOptions?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          const signal = requestOptions?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const promise = chatJson(["first-model", "second-model"], MESSAGES, {
      signal: controller.signal,
    });
    controller.abort(new Error("vision deadline reached"));

    await expect(promise).rejects.toThrow("vision deadline reached");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });

  it("uses strict json_schema and OpenRouter parameter requirements when a schema is supplied", async () => {
    createMock.mockResolvedValueOnce(okCompletion('{"answer":42}'));

    await expect(
      chatJson("test-model", MESSAGES, {
        schemaName: "answer",
        jsonSchema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
          additionalProperties: false,
        },
      }),
    ).resolves.toEqual({ answer: 42 });

    const params = createMock.mock.calls[0]?.[0] as {
      response_format?: { type?: string; json_schema?: { name?: string; strict?: boolean } };
      provider?: { require_parameters?: boolean };
    };
    expect(params.response_format?.type).toBe("json_schema");
    expect(params.response_format?.json_schema?.name).toBe("answer");
    expect(params.response_format?.json_schema?.strict).toBe(true);
    expect(params.provider?.require_parameters).toBe(true);
  });

  it("falls back to the next model when the first model returns invalid JSON", async () => {
    createMock
      .mockResolvedValueOnce(okCompletion("not json"))
      .mockResolvedValueOnce(okCompletion('{"ok":true}'));

    await expect(chatJson(["bad-model", "good-model"], MESSAGES)).resolves.toEqual({ ok: true });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ model: "bad-model" });
    expect(createMock.mock.calls[1]?.[0]).toMatchObject({ model: "good-model" });
  });

  it("falls back to the next model when the first model returns empty content", async () => {
    createMock
      .mockResolvedValueOnce(okCompletion(""))
      .mockResolvedValueOnce(okCompletion('{"ok":true}'));

    await expect(chatJson(["empty-model", "good-model"], MESSAGES)).resolves.toEqual({ ok: true });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ model: "empty-model" });
    expect(createMock.mock.calls[1]?.[0]).toMatchObject({ model: "good-model" });
  });

  it("falls back to the next model on OpenRouter provider 429 envelopes", async () => {
    createMock
      .mockResolvedValueOnce({ error: { message: "429 Provider returned error" } })
      .mockResolvedValueOnce(okCompletion('{"ok":true}'));

    await expect(chatJson(["rate-limited-model", "good-model"], MESSAGES)).resolves.toEqual({
      ok: true,
    });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ model: "rate-limited-model" });
    expect(createMock.mock.calls[1]?.[0]).toMatchObject({ model: "good-model" });
  });

  it("surfaces a clear error when a 200 body is an error envelope (no choices)", async () => {
    createMock.mockResolvedValueOnce({ error: { message: "No endpoints found for model: potentially private echoed content" } });

    const promise = chatJson("test-model", MESSAGES);
    // The whole point: NOT the cryptic undefined-read crash.
    await expect(promise).rejects.not.toThrow(/reading '0'/);
    await expect(promise).rejects.toThrow(/LLM request failed/);
    await expect(promise).rejects.not.toThrow(/potentially private echoed content/);
  });

  it("surfaces a clear error when the body simply has no choices", async () => {
    createMock.mockResolvedValueOnce({}); // no choices, no error object

    const promise = chatJson("test-model", MESSAGES);
    await expect(promise).rejects.not.toThrow(/reading '0'/);
    await expect(promise).rejects.toThrow(/no choices/i);
  });

  it("flags a truncated reply (finish_reason 'length') with an actionable hint", async () => {
    // Reasoning model burned the whole budget thinking, so only prose came back.
    createMock.mockResolvedValueOnce(
      okCompletion("The user wants me to analyze a set of elements", "length"),
    );

    const promise = chatJson("test-model", MESSAGES);
    await expect(promise).rejects.toThrow(/did not return valid JSON/);
    await expect(promise).rejects.toThrow(/cut off at max_tokens/);
  });

  it("retries an embedded rate-limit envelope, then succeeds", async () => {
    vi.useFakeTimers();
    createMock
      .mockResolvedValueOnce({ error: { code: 429, message: "rate limited" } })
      .mockResolvedValueOnce(okCompletion('{"ok":true}'));

    const promise = chatJson("test-model", MESSAGES);
    await vi.runAllTimersAsync(); // fast-forward the backoff sleep

    await expect(promise).resolves.toEqual({ ok: true });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("retries a rate-limit flagged via metadata.error_type", async () => {
    vi.useFakeTimers();
    createMock
      .mockResolvedValueOnce({ error: { metadata: { error_type: "rate_limit_exceeded" } } })
      .mockResolvedValueOnce(okCompletion('{"ok":true}'));

    const promise = chatJson("test-model", MESSAGES);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ ok: true });
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});
