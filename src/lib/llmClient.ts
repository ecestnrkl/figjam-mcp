import OpenAI from "openai";
import { readIntEnv } from "./env.js";
import { getModelConfig, getModelsForRole } from "./modelRegistry.js";
import { getLlmRequestTimeoutMs } from "./llmTimeouts.js";

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
let clientConfig: string | undefined;

export class LlmRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfter?: number) { super(message); }
}
export class LLMConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "LLMConfigurationError"; }
}
export class LlmTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "LlmTimeoutError"; }
}

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
  /** Explicit opt-in; omitted requests retain the selected model's reasoning default. */
  reasoningEffort?: LlmReasoningEffort;
  /** Per-HTTP-attempt deadline, including the response body; caller cancellation can end it earlier. */
  requestTimeoutMs?: number;
  schemaName?: string;
  jsonSchema?: JsonSchema;
  onModelUsed?: (model: string) => void;
  onUsage?: (usage: { model: string; promptTokens?: number; completionTokens?: number; totalTokens?: number }) => void;
  onRequest?: (model: string) => void;
  /** Optional caller-owned cancellation, e.g. an ingest phase deadline. */
  signal?: AbortSignal;
}

export type JsonSchema = Record<string, unknown>;
const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
export type LlmReasoningEffort = typeof REASONING_EFFORTS[number];

/** Applies only to answer_from_board; vision and other roles keep their own defaults. */
export function getAnswerReasoningEffort(): LlmReasoningEffort | undefined {
  const value = process.env.LLM_ANSWER_REASONING_EFFORT?.trim();
  if (!value) return undefined;
  validateReasoningEffort(value, "LLM_ANSWER_REASONING_EFFORT");
  return value;
}

function validateReasoningEffort(value: unknown, name: string): asserts value is LlmReasoningEffort {
  if (!REASONING_EFFORTS.includes(value as LlmReasoningEffort)) {
    throw new LLMConfigurationError(`${name} must be one of: ${REASONING_EFFORTS.join(", ")}`);
  }
}

/** Reads a required env var or fails with a setup hint. */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new LLMConfigurationError(
      `${name} is not set — configure it in your MCP client's environment, or in .env when starting from the project directory.`,
    );
  }
  return value;
}

/** Validate required settings before spending Figma requests on vision input. */
export function validateLlmConfiguration(): void {
  requireEnv("LLM_BASE_URL");
  requireEnv("LLM_API_KEY");
}

/** Lazily constructs (and caches) the OpenAI-compatible client. */
export function getLlmClient(): OpenAI {
  const baseURL = requireEnv("LLM_BASE_URL");
  const apiKey = requireEnv("LLM_API_KEY");
  const config = JSON.stringify([baseURL, apiKey]);
  if (!client || clientConfig !== config) client = new OpenAI({
    baseURL,
    apiKey,
    timeout: getLlmRequestTimeoutMs(),
    maxRetries: LLM_SDK_MAX_RETRIES,
  });
  clientConfig = config;
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
 * Try the requested JSON schema, then JSON mode, then prompt-only JSON, but
 * only downgrade when the provider identifies a formatting incompatibility.
 * An unavailable model goes straight to the next configured candidate.
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
      if (options.signal?.aborted) {
        throw abortReason(options.signal, error);
      }
      errors.push(error);
      if (candidate !== models.at(-1) && shouldTryNextModel(error)) {
        console.error(
          `LLM model ${candidate} failed; trying the next explicitly configured candidate.`,
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
  const base: ParamsWithOpenRouterProvider = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: options.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
  };
  if (options.reasoningEffort !== undefined) {
    validateReasoningEffort(options.reasoningEffort, "reasoningEffort");
    // OpenRouter normalizes reasoning across providers; other compatible APIs
    // use the standard field. Neither is sent without an explicit opt-in.
    if (new URL(llm.baseURL).hostname === "openrouter.ai") {
      base.reasoning = { effort: options.reasoningEffort };
    } else base.reasoning_effort = options.reasoningEffort;
  }

  const formats = responseFormatAttempts(options);
  for (const responseFormat of formats) {
    try {
      const params = responseFormat ? { ...base, response_format: responseFormat } : base;
      return await createCompletion(llm, withProviderRequirements(params), options);
    } catch (error) {
      if (!isUnsupportedParamError(error, options.reasoningEffort !== undefined) || responseFormat === formats.at(-1)) {
        throw error;
      }
    }
  }

  return createCompletion(llm, base, options);
}

type ResponseFormat = NonNullable<OpenAI.ChatCompletionCreateParamsNonStreaming["response_format"]>;
type ParamsWithOpenRouterProvider = OpenAI.ChatCompletionCreateParamsNonStreaming & {
  provider?: { require_parameters?: boolean };
  reasoning?: { effort: LlmReasoningEffort };
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
  params: ParamsWithOpenRouterProvider,
): ParamsWithOpenRouterProvider {
  if ((!params.response_format && !params.reasoning && params.reasoning_effort === undefined) || !getModelConfig().providerRequireParameters) {
    return params;
  }
  return {
    ...params,
    provider: { require_parameters: true },
  } as ParamsWithOpenRouterProvider;
}

function isUnsupportedParamError(error: unknown, hasExplicitReasoning = false): boolean {
  if (!(error instanceof OpenAI.APIError) || ![400, 404, 422].includes(error.status ?? 0)) return false;
  const detail = providerErrorDetail(error);
  // OpenRouter can use 404 both for missing models and for endpoints excluded
  // by require_parameters. Status alone cannot decide whether less strict JSON
  // formatting will help. Never treat unrelated billing/policy/input failures
  // as permission to downgrade the requested format.
  const format = /\b(?:response[_ -]?format|json[_ -]?(?:schema|object|mode)|structured[_ -]?outputs?)\b/i;
  const unsupported = /unsupported|not[_ -]supported|does(?:n't| not) support|do(?:n't| not) support|cannot support|only supports|no (?:available )?endpoints|unavailable|not available|unrecognized|unknown (?:parameter|argument|field)|not (?:allowed|permitted|compatible)/i;
  // With two requested capabilities, generic parameter-routing errors no
  // longer identify JSON as the problem. Never strip formatting to mask an
  // unsupported reasoning setting, nor silently remove that setting.
  if (hasExplicitReasoning && /\b(?:reasoning(?:[_ -]effort)?|thinking)\b/i.test(detail)) return false;
  if (format.test(detail) && unsupported.test(detail)) return true;
  if (hasExplicitReasoning) return false;
  return (/\brequire[_ -]?parameters\b/i.test(detail) && unsupported.test(detail)) ||
    /no (?:available )?endpoints.*(?:support|match|handle).*\b(?:requested|required) parameters\b/i.test(detail) ||
    /\bFilter by Parameters\b/i.test(detail);
}

function isUnavailableModelError(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError) || ![400, 404, 410, 422].includes(error.status ?? 0)) return false;
  const detail = providerErrorDetail(error);
  return /\b(?:model[_ -]not[_ -]found|invalid[_ -]model|model[_ -]unavailable)\b|\bno (?:available )?endpoints\b|\bmodel\b.*\b(?:not found|does not exist|not available|unavailable|not a valid|decommissioned)\b|\b(?:unknown|invalid|unavailable|not a valid) model\b/i.test(detail);
}

/** Inspect only known error fields; provider details never enter our logs/errors. */
function providerErrorDetail(error: InstanceType<typeof OpenAI.APIError>): string {
  const body = error.error && typeof error.error === "object" ? error.error as Record<string, unknown> : {};
  const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata as Record<string, unknown> : {};
  // OpenRouter can wrap the actual format error in metadata.raw while its
  // top-level message says only "Provider returned error". Parse a bounded JSON
  // envelope, not arbitrary provider text or recursively nested metadata.
  let raw: unknown = metadata.raw;
  if (typeof raw === "string") {
    try { raw = raw.length <= 16_384 ? JSON.parse(raw) : undefined; }
    catch { raw = undefined; }
  }
  const rawBody = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const nested = rawBody.error && typeof rawBody.error === "object" ? rawBody.error as Record<string, unknown> : {};
  return [body.message ?? error.message, error.param, error.code, error.type,
    metadata.error_type, metadata.provider_code, metadata.failed_routing_step,
    rawBody.message, rawBody.param, rawBody.code, rawBody.type, nested.message, nested.param, nested.code, nested.type]
    .filter((value): value is string => typeof value === "string")
    .map(value => value.slice(0, 4096))
    .join(" ");
}

function shouldTryNextModel(error: unknown): boolean {
  if (error instanceof LlmRequestError) return error.status === 429 || (error.status ?? 0) >= 500;
  if (error instanceof LlmInvalidJsonError || isLlmTimeout(error)) {
    return true;
  }
  if (error instanceof OpenAI.RateLimitError) {
    return true;
  }
  if (error instanceof OpenAI.APIError) {
    return error.status === 408 || error.status === 429 || error.status >= 500 ||
      isUnavailableModelError(error) || isUnsupportedParamError(error);
  }
  if (error instanceof Error) {
    return /429|provider returned error|rate limit|no endpoints|empty response|no choices|timed out|unsupported|response contained/i.test(
      error.message,
    );
  }
  return false;
}

function normalizeLlmError(error: unknown): unknown {
  if (!(error instanceof OpenAI.APIError)) return error;
  const retryAfter = Number(error.headers?.get("retry-after"));
  return new LlmRequestError(`LLM request failed (HTTP ${error.status ?? "unknown"}). Check provider availability and configuration.`, error.status,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
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
  options: ChatJsonOptions = {},
): Promise<OpenAI.ChatCompletion> {
  const { signal } = options;
  const requestTimeoutMs = options.requestTimeoutMs ?? getLlmRequestTimeoutMs();
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000) {
    throw new LLMConfigurationError("requestTimeoutMs must be an integer >= 1000");
  }
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    let completion: OpenAI.ChatCompletion;
    try {
      options.onRequest?.(params.model);
      completion = await llm.chat.completions.create(params, { signal, timeout: requestTimeoutMs });
      options.onUsage?.({ model: params.model, promptTokens: completion.usage?.prompt_tokens,
        completionTokens: completion.usage?.completion_tokens, totalTokens: completion.usage?.total_tokens });
    } catch (error) {
      if (signal?.aborted) {
        throw abortReason(signal, error);
      }
      if (isLlmTimeout(error)) {
        throw new LlmTimeoutError(
          `LLM request timed out after ${requestTimeoutMs / 1000}s. ` +
            "Check the model, output-token budget and caller deadline. " +
            "Adjust LLM_VISION_REQUEST_TIMEOUT_MS for vision or LLM_REQUEST_TIMEOUT_MS for text.",
        );
      }
      if (!(error instanceof OpenAI.RateLimitError) || attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw error;
      }
      await backoff(retryDelayMs(error, attempt), attempt, signal);
      continue;
    }

    // Reached here on a 2xx — but the "success" body may actually be an error
    // envelope with no usable choices (see EmbeddedErrorEnvelope).
    const embedded = embeddedError(completion);
    if (!embedded) {
      return completion;
    }
    if (isRateLimit(embedded) && attempt < MAX_RATE_LIMIT_RETRIES) {
      await backoff(2 ** attempt * 2000, attempt, signal);
      continue;
    }
    throw new LlmRequestError(`LLM request failed: ${isRateLimit(embedded) ? "rate limit exceeded (429)" : "response contained no choices"}`,
      isRateLimit(embedded) ? 429 : Number(embedded.code) || 502);
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
async function backoff(
  waitMs: number,
  attempt: number,
  signal?: AbortSignal,
): Promise<void> {
  const cappedWaitMs = Math.min(waitMs, MAX_RATE_LIMIT_BACKOFF_MS);
  console.error(
    `LLM rate limited — retrying in ${Math.round(cappedWaitMs / 1000)}s ` +
      `(attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})…`,
  );
  await sleep(cappedWaitMs, signal);
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal, fallback?: unknown): unknown {
  return signal.reason ?? fallback ?? new Error("LLM request aborted");
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
    `LLM (${model}) did not return valid JSON.${hint}`,
    raw,
    finishReason,
  );
}
