import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * These tests exercise chatJson against a stubbed OpenAI client. The focus is
 * the failure mode where an OpenAI-compatible router (OpenRouter's free tier)
 * reports an error inside a 200 OK body with NO `choices` array — which used to
 * crash with "Cannot read properties of undefined (reading '0')".
 */

// Hoisted so the vi.mock factory (which is hoisted above module init) can see it.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("openai", async (importActual) => {
  const actual = await importActual<typeof import("openai")>();
  const Real = actual.default;
  // Subclass-ish stub: `new OpenAI()` yields our controllable create(), while
  // the static error classes used by instanceof checks are preserved.
  class MockOpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts?: unknown) {}
    static RateLimitError = Real.RateLimitError;
    static APIError = Real.APIError;
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
  it("parses a normal completion", async () => {
    createMock.mockResolvedValueOnce(okCompletion('{"answer":42}'));
    await expect(chatJson("test-model", MESSAGES)).resolves.toEqual({ answer: 42 });
  });

  it("surfaces a clear error when a 200 body is an error envelope (no choices)", async () => {
    createMock.mockResolvedValueOnce({ error: { message: "No endpoints found for model" } });

    const promise = chatJson("test-model", MESSAGES);
    // The whole point: NOT the cryptic undefined-read crash.
    await expect(promise).rejects.not.toThrow(/reading '0'/);
    await expect(promise).rejects.toThrow(/No endpoints found for model/);
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
