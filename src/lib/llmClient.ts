import OpenAI from "openai";
import { readIntEnv } from "./env.js";
import { getModelConfig, getModelsForRole } from "./modelRegistry.js";

/**
 * Shared LLM access for visionInterpreter.ts and answerFromBoard.ts.
 *
 * Talks to any OpenAI-compatible chat completions endpoint (OpenRouter,
 * GitHub Models, OpenAI, a local server, …) configured via env vars:
 *   LLM_BASE_URL      e.g. https://openrouter.ai/api/v1
 *   LLM_API_KEY       provider API key
 *   LLM_MODEL_PRESET  default role-based model preset
 *   LLM_*_MODELS      optional comma-separated role-specific candidates
 */

let client: OpenAI | undefined;

export class LlmInvalidJsonError extends Error {
  constructor(
    message: string,
    readonly rawReply: string,
    readonly finishReason?: string | null,
  ) {
    super(message);
    this.name = "LlmInvalidJsonError";
  }
}

export interface ChatJsonOptions {
  maxOutputTokens?: number;
  schemaName?: string;
  jsonSchema?: JsonSchema;
  onModelUsed?: (model: string) => void;
}

export type JsonSchema = Record<string, unknown>;

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
    timeout: LLM_REQUEST_TIMEOUT_MS,
    maxRetries: LLM_SDK_MAX_RETRIES,
  });
  return client;
}

export function getVisionModel(): string {
  return getVisionModels()[0]!;
}

export function getTextModel(): string {
  return getTextModels()[0]!;
}

export function getVisionModels(): string[] {
  return getModelsForRole("vision");
}

export function getTextModels(): string[] {
  return getModelsForRole("text");
}

export function getFastTextModels(): string[] {
  return getModelsForRole("fastText");
}

/** Max extra attempts after a 429 before giving up (free-tier limits reset per minute). */
const MAX_RATE_LIMIT_RETRIES = readIntEnv("LLM_RATE_LIMIT_RETRIES", 1, 0);

/** Cap provider Retry-After delays so MCP clients receive a response before their own timeout. */
const MAX_RATE_LIMIT_BACKOFF_MS = readIntEnv("LLM_RATE_LIMIT_MAX_BACKOFF_MS", 5000, 0);

/**
 * The OpenAI SDK defaults to 10 minutes and retries timeouts twice. MCP UI
 * clients usually give up much earlier, so keep LLM calls bounded here.
 */
const LLM_REQUEST_TIMEOUT_MS = readIntEnv("LLM_REQUEST_TIMEOUT_MS", 20000, 1000);
const LLM_SDK_MAX_RETRIES = readIntEnv("LLM_SDK_MAX_RETRIES", 0, 0);

/**
 * Output token budget. This must cover BOTH the JSON answer AND any hidden
 * reasoning tokens: the free router often serves reasoning models (e.g.
 * nemotron-nano) that spend 500–1000+ tokens "thinking" before emitting the
 * JSON, and those reasoning tokens count against this budget. Set too low, the
 * reply is truncated mid-reasoning (finish_reason "length") and no JSON is ever
 * produced — surfacing as a confusing "did not return valid JSON" on a reply
 * that starts with prose like "The user wants me to analyze…".
 */
const MAX_OUTPUT_TOKENS = readIntEnv("LLM_MAX_OUTPUT_TOKENS", 14096, 1);

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
  model: string | string[],
  messages: OpenAI.ChatCompletionMessageParam[],
  options: ChatJsonOptions = {},
): Promise<unknown> {
  const llm = getLlmClient();
  const models = Array.isArray(model) ? model : [model];
  const errors: unknown[] = [];

  for (const candidate of models) {
    try {
      const completion = await createJsonCompletion(llm, candidate, messages, options);
      const choice = completion.choices[0];
      const raw = choice?.message?.content;
      if (!raw) {
        throw new Error(`LLM (${candidate}) returned an empty response`);
      }
      const parsed = parseJsonReply(raw, candidate, choice?.finish_reason);
      options.onModelUsed?.(candidate);
      return parsed;
    } catch (error) {
      errors.push(error);
      if (candidate !== models.at(-1) && shouldTryNextModel(error)) {
        console.error(
          `LLM model ${candidate} failed; trying next candidate: ${errorMessage(error)}`,
        );
        continue;
      }
      throw normalizeLlmError(error);
    }
  }

  throw normalizeLlmError(errors.at(-1) ?? new Error("LLM request failed"));
}

async function createJsonCompletion(
  llm: OpenAI,
  model: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  options: ChatJsonOptions,
): Promise<OpenAI.ChatCompletion> {
  const base: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: options.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
  };

  const formats = responseFormatAttempts(options);
  for (const responseFormat of formats) {
    try {
      const params = responseFormat ? { ...base, response_format: responseFormat } : base;
      return await createCompletion(llm, withProviderRequirements(params));
    } catch (error) {
      if (!isUnsupportedParamError(error) || responseFormat === formats.at(-1)) {
        throw error;
      }
    }
  }

  return createCompletion(llm, base);
}

type ResponseFormat = NonNullable<OpenAI.ChatCompletionCreateParamsNonStreaming["response_format"]>;
type ParamsWithOpenRouterProvider = OpenAI.ChatCompletionCreateParamsNonStreaming & {
  provider?: { require_parameters?: boolean };
};

function responseFormatAttempts(options: ChatJsonOptions): Array<ResponseFormat | undefined> {
  if (options.jsonSchema) {
    return [
      {
        type: "json_schema",
        json_schema: {
          name: options.schemaName ?? "structured_reply",
          strict: true,
          schema: options.jsonSchema,
        },
      } as ResponseFormat,
      { type: "json_object" },
      undefined,
    ];
  }
  return [{ type: "json_object" }, undefined];
}

function withProviderRequirements(
  params: OpenAI.ChatCompletionCreateParamsNonStreaming,
): OpenAI.ChatCompletionCreateParamsNonStreaming {
  if (!params.response_format || !getModelConfig().providerRequireParameters) {
    return params;
  }
  return {
    ...params,
    provider: { require_parameters: true },
  } as ParamsWithOpenRouterProvider;
}

function isUnsupportedParamError(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIError &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 403 &&
    error.status !== 429
  );
}

function shouldTryNextModel(error: unknown): boolean {
  if (error instanceof LlmInvalidJsonError || isLlmTimeout(error)) {
    return true;
  }
  if (error instanceof OpenAI.RateLimitError) {
    return true;
  }
  if (error instanceof OpenAI.APIError) {
    return error.status === 429 || error.status >= 500 || isUnsupportedParamError(error);
  }
  if (error instanceof Error) {
    return /429|provider returned error|rate limit|no endpoints|empty response|no choices|timed out|unsupported|response contained/i.test(
      error.message,
    );
  }
  return false;
}

function normalizeLlmError(error: unknown): unknown {
  return error instanceof OpenAI.APIError ? new Error(`LLM request failed: ${error.message}`) : error;
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
 * free providers hit this often on boards with many image-heavy clusters, since
 * each refined cluster is one more request against a per-minute quota. Rate
 * limits arrive two ways — as a thrown HTTP 429, or embedded in a 200 body —
 * and both are retried here. Other failures surface as clear errors.
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
      if (isLlmTimeout(error)) {
        throw new Error(
          `LLM request timed out after ${Math.round(LLM_REQUEST_TIMEOUT_MS / 1000)}s. ` +
            "Use a faster model, lower LLM_MAX_OUTPUT_TOKENS, or increase LLM_REQUEST_TIMEOUT_MS/client timeout.",
        );
      }
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
  const cappedWaitMs = Math.min(waitMs, MAX_RATE_LIMIT_BACKOFF_MS);
  console.error(
    `LLM rate limited — retrying in ${Math.round(cappedWaitMs / 1000)}s ` +
      `(attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})…`,
  );
  await sleep(cappedWaitMs);
}

/** Retry-After header (seconds) if the provider sent one, else exponential backoff from 2s. */
function retryDelayMs(error: InstanceType<typeof OpenAI.RateLimitError>, attempt: number): number {
  const retryAfter = Number(error.headers?.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 2000;
}

function isLlmTimeout(error: unknown): boolean {
  const TimeoutError = OpenAI.APIConnectionTimeoutError;
  return (
    (typeof TimeoutError === "function" && error instanceof TimeoutError) ||
    (error instanceof Error && error.name === "APIConnectionTimeoutError")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      ? " The reply was cut off at max_tokens before valid JSON was produced — " +
        "the selected model may be emitting visible reasoning instead of JSON. " +
        "Use a JSON-capable/non-reasoning model or raise the relevant output-token limit."
      : "";
  throw new LlmInvalidJsonError(
    `LLM (${model}) did not return valid JSON.${hint} Reply started with: "${raw.slice(0, 120)}"`,
    raw,
    finishReason,
  );
}
