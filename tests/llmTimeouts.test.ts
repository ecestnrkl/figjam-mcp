import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAnswerRequestTimeoutMs, getAnswerTotalTimeoutMs, getLlmRequestTimeoutMs, getVisionRequestTimeoutMs,
} from "../src/lib/llmTimeouts.js";

afterEach(() => vi.unstubAllEnvs());

describe("role-specific request deadlines", () => {
  it.each([
    ["", "", 20_000, 60_000],
    ["90000", "", 90_000, 90_000],
    ["20000", "60000", 20_000, 60_000],
    ["90000", "30000", 90_000, 30_000],
    ["", "15000", 20_000, 15_000],
  ])("resolves global %j and vision %j independently", (global, vision, textMs, visionMs) => {
    vi.stubEnv("LLM_REQUEST_TIMEOUT_MS", global);
    vi.stubEnv("LLM_VISION_REQUEST_TIMEOUT_MS", vision);
    expect(getLlmRequestTimeoutMs()).toBe(textMs);
    expect(getVisionRequestTimeoutMs()).toBe(visionMs);
  });

  it.each(["0", "-1", "1.5", "invalid"])("rejects an invalid vision deadline (%s)", value => {
    vi.stubEnv("LLM_REQUEST_TIMEOUT_MS", "");
    vi.stubEnv("LLM_VISION_REQUEST_TIMEOUT_MS", value);
    expect(getVisionRequestTimeoutMs).toThrow("LLM_VISION_REQUEST_TIMEOUT_MS must be an integer >= 1000");
    expect(getLlmRequestTimeoutMs()).toBe(20_000);
  });

  it.each([
    ["", "", 40_000, 50_000],
    ["30000", "", 30_000, 50_000],
    ["30000", "45000", 45_000, 50_000],
    ["", "90000", 90_000, 90_000],
    ["90000", "", 90_000, 90_000],
  ])("resolves the answer deadline from global %j and answer %j", (global, answer, requestMs, totalMs) => {
    vi.stubEnv("LLM_REQUEST_TIMEOUT_MS", global);
    vi.stubEnv("LLM_ANSWER_REQUEST_TIMEOUT_MS", answer);
    expect(getAnswerRequestTimeoutMs()).toBe(requestMs);
    expect(getAnswerTotalTimeoutMs()).toBe(totalMs);
  });

  it("rejects an invalid answer deadline", () => {
    vi.stubEnv("LLM_ANSWER_REQUEST_TIMEOUT_MS", "500");
    expect(getAnswerRequestTimeoutMs).toThrow("LLM_ANSWER_REQUEST_TIMEOUT_MS must be an integer >= 1000");
  });
});
