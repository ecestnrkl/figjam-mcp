import { readIntEnv } from "./env.js";

/*
 * Output budgets shared by the production calls and diagnose_llm_config, so the
 * diagnostic checks the same conditions. Both include hidden reasoning tokens
 * on compatible providers.
 */

export function getAnswerMaxOutputTokens(): number {
  return readIntEnv("LLM_ANSWER_MAX_OUTPUT_TOKENS", 2048, 1);
}

/**
 * Vision refinement returns only a label, a short summary, and a bounded ID
 * list. Give reasoning models enough room to reach that JSON.
 */
export function getVisionMaxOutputTokens(): number {
  return readIntEnv("LLM_VISION_MAX_OUTPUT_TOKENS", 4096, 256);
}
