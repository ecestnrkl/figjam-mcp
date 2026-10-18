import { readIntEnv } from "./env.js";

/** The legacy global setting remains the text default and an explicit override for all roles. */
export function getLlmRequestTimeoutMs(): number {
  return readIntEnv("LLM_REQUEST_TIMEOUT_MS", 20_000, 1000);
}

/** A role-specific override wins; an existing global override keeps its previous meaning. */
export function getVisionRequestTimeoutMs(): number {
  return readIntEnv("LLM_VISION_REQUEST_TIMEOUT_MS",
    readIntEnv("LLM_REQUEST_TIMEOUT_MS", 60_000, 1000), 1000);
}

/** Answers send large prompts, often to reasoning models, so they get a longer default than other text requests. */
export function getAnswerRequestTimeoutMs(): number {
  return readIntEnv("LLM_ANSWER_REQUEST_TIMEOUT_MS",
    readIntEnv("LLM_REQUEST_TIMEOUT_MS", 40_000, 1000), 1000);
}

/**
 * Total time for one answer across all model candidates, so answer_from_board
 * replies inside a 60 s client timeout. A larger explicit per-request setting
 * still applies to the first candidate.
 */
export function getAnswerTotalTimeoutMs(): number {
  return Math.max(50_000, getAnswerRequestTimeoutMs());
}
