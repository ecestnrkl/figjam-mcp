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
