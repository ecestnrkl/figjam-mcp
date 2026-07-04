import OpenAI from "openai";

/**
 * Shared LLM access for visionInterpreter.ts and answerFromBoard.ts.
 *
 * Talks to any OpenAI-compatible chat completions endpoint (OpenRouter,
 * GitHub Models, OpenAI, a local server, …) configured via env vars:
 *   LLM_BASE_URL      e.g. https://openrouter.ai/api/v1
 *   LLM_API_KEY       provider API key
 *   LLM_VISION_MODEL  model used for image+text requests
 *   LLM_TEXT_MODEL    model used for text-only requests
 */

let client: OpenAI | undefined;

/** Reads a required env var or fails with a setup hint. */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set — copy .env.example to .env and fill in the LLM settings.`,
    );
  }
  return value;
}

/** Lazily constructs (and caches) the OpenAI-compatible client. */
export function getLlmClient(): OpenAI {
  client ??= new OpenAI({
    baseURL: requireEnv("LLM_BASE_URL"),
    apiKey: requireEnv("LLM_API_KEY"),
  });
  return client;
}

export function getVisionModel(): string {
  return requireEnv("LLM_VISION_MODEL");
}

export function getTextModel(): string {
  return requireEnv("LLM_TEXT_MODEL");
}

/**
 * Runs a chat completion that must yield a JSON object.
 *
 * Strategy: first try with `response_format: { type: "json_object" }`; if the
 * endpoint rejects that (4xx — not every model supports it), retry once
 * without it and rely on the prompt's "reply with JSON only" instruction.
 * The reply is parsed defensively (markdown fences stripped, first {...}
 * block extracted) and failures surface as clear errors.
 */
export async function chatJson(
  model: string,
  messages: OpenAI.ChatCompletionMessageParam[],
): Promise<unknown> {
  const llm = getLlmClient();
  const base: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 1024,
  };

  let completion: OpenAI.ChatCompletion;
  try {
    completion = await llm.chat.completions.create({
      ...base,
      response_format: { type: "json_object" },
    });
  } catch (error) {
    const clientError =
      error instanceof OpenAI.APIError &&
      typeof error.status === "number" &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 401 &&
      error.status !== 403 &&
      error.status !== 429;
    if (!clientError) {
      throw new Error(`LLM request failed: ${(error as Error).message}`);
    }
    // Model likely doesn't support response_format — fall back to prompt-only JSON.
    completion = await llm.chat.completions.create(base);
  }

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    throw new Error(`LLM (${model}) returned an empty response`);
  }
  return parseJsonReply(raw, model);
}

/** Parses a model reply into JSON, tolerating fences and surrounding prose. */
function parseJsonReply(raw: string, model: string): unknown {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  try {
    return JSON.parse(stripped);
  } catch {
    // Some models wrap JSON in prose; grab the outermost {...} block.
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through to the error below
      }
    }
  }
  throw new Error(
    `LLM (${model}) did not return valid JSON. Reply started with: "${raw.slice(0, 120)}"`,
  );
}
