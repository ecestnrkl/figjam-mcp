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

/** Max extra attempts after a 429 before giving up (free-tier limits reset per minute). */
const MAX_RATE_LIMIT_RETRIES = 4;

/**
 * Output token budget. This must cover BOTH the JSON answer AND any hidden
 * reasoning tokens: the free router often serves reasoning models (e.g.
 * nemotron-nano) that spend 500–1000+ tokens "thinking" before emitting the
 * JSON, and those reasoning tokens count against this budget. Set too low, the
 * reply is truncated mid-reasoning (finish_reason "length") and no JSON is ever
 * produced — surfacing as a confusing "did not return valid JSON" on a reply
 * that starts with prose like "The user wants me to analyze…".
 */
const MAX_OUTPUT_TOKENS = 4096;

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
    max_tokens: MAX_OUTPUT_TOKENS,
  };

  let completion: OpenAI.ChatCompletion;
  try {
    completion = await createCompletion(llm, { ...base, response_format: { type: "json_object" } });
  } catch (error) {
    const unsupportedParam =
      error instanceof OpenAI.APIError &&
      typeof error.status === "number" &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 401 &&
      error.status !== 403 &&
      error.status !== 429;
    if (!unsupportedParam) {
      // Wrap raw SDK errors for context; pass our own descriptive errors
      // (e.g. an embedded-error envelope) through unchanged to avoid double prefixing.
      throw error instanceof OpenAI.APIError
        ? new Error(`LLM request failed: ${error.message}`)
        : error;
    }
    // Model likely doesn't support response_format — fall back to prompt-only JSON.
    completion = await createCompletion(llm, base);
  }

  const choice = completion.choices[0];
  const raw = choice?.message?.content;
  if (!raw) {
    throw new Error(`LLM (${model}) returned an empty response`);
  }
  return parseJsonReply(raw, model, choice?.finish_reason);
}

/**
 * Shape some OpenAI-compatible routers use when they report a failure inside a
 * 200 OK body instead of a non-2xx status. Notably OpenRouter does this for
 * rate limits, upstream provider errors, and moderation: the body carries an
 * `error` object and NO `choices` array. The SDK doesn't throw on a 200, so
 * without this handling `completion.choices[0]` blows up with the opaque
 * "Cannot read properties of undefined (reading '0')".
 */
interface EmbeddedErrorEnvelope {
  error?: {
    message?: string;
    code?: number | string;
    metadata?: { error_type?: string };
  };
}

/**
 * Calls the chat completions endpoint, retrying on rate limits with backoff
 * (honoring a Retry-After header when the provider sends one). Free-tier
 * routers like OpenRouter's `openrouter/free` hit this often on boards with
 * many clusters, since each cluster is one more request against a per-minute
 * quota. Rate limits arrive two ways — as a thrown HTTP 429, or embedded in a
 * 200 body — and both are retried here. Other failures surface as clear errors.
 */
async function createCompletion(
  llm: OpenAI,
  params: OpenAI.ChatCompletionCreateParamsNonStreaming,
): Promise<OpenAI.ChatCompletion> {
  for (let attempt = 0; ; attempt++) {
    let completion: OpenAI.ChatCompletion;
    try {
      completion = await llm.chat.completions.create(params);
    } catch (error) {
      if (!(error instanceof OpenAI.RateLimitError) || attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw error;
      }
      await backoff(retryDelayMs(error, attempt), attempt);
      continue;
    }

    // Reached here on a 2xx — but the "success" body may actually be an error
    // envelope with no usable choices (see EmbeddedErrorEnvelope).
    const embedded = embeddedError(completion);
    if (!embedded) {
      return completion;
    }
    if (isRateLimit(embedded) && attempt < MAX_RATE_LIMIT_RETRIES) {
      await backoff(2 ** attempt * 2000, attempt);
      continue;
    }
    throw new Error(`LLM request failed: ${embedded.message ?? "response contained no choices"}`);
  }
}

/**
 * Returns the error object when a "successful" completion is really an error
 * envelope (or is missing its choices), otherwise undefined. A response with an
 * empty `choices` array is treated as an error so we fail with a clear message.
 */
function embeddedError(
  completion: OpenAI.ChatCompletion,
): NonNullable<EmbeddedErrorEnvelope["error"]> | undefined {
  const envelope = completion as unknown as EmbeddedErrorEnvelope;
  if (envelope.error) {
    return envelope.error;
  }
  if (!Array.isArray(completion.choices) || completion.choices.length === 0) {
    return { message: "response contained no choices" };
  }
  return undefined;
}

/** True when an embedded error is a rate limit (OpenRouter uses code 429 / metadata). */
function isRateLimit(error: NonNullable<EmbeddedErrorEnvelope["error"]>): boolean {
  return (
    error.code === 429 ||
    error.code === "429" ||
    error.metadata?.error_type === "rate_limit_exceeded"
  );
}

/** Logs a retry notice and waits before the next attempt. */
async function backoff(waitMs: number, attempt: number): Promise<void> {
  console.error(
    `LLM rate limited — retrying in ${Math.round(waitMs / 1000)}s ` +
      `(attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})…`,
  );
  await sleep(waitMs);
}

/** Retry-After header (seconds) if the provider sent one, else exponential backoff from 2s. */
function retryDelayMs(error: InstanceType<typeof OpenAI.RateLimitError>, attempt: number): number {
  const retryAfter = Number(error.headers?.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 2000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses a model reply into JSON, tolerating fences and surrounding prose. */
function parseJsonReply(raw: string, model: string, finishReason?: string | null): unknown {
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
  const hint =
    finishReason === "length"
      ? " The reply was cut off at max_tokens before the JSON was complete — " +
        "raise MAX_OUTPUT_TOKENS (reasoning models spend part of the budget thinking first)."
      : "";
  throw new Error(
    `LLM (${model}) did not return valid JSON.${hint} Reply started with: "${raw.slice(0, 120)}"`,
  );
}
