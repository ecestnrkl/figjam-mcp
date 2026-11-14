import { redactMessage, redactOutputSecrets } from "../lib/secrets.js";
import type { DiagnoseLlmConfigOutput } from "../schemas/diagnoseLlmConfig.js";
import {
  chatJson, getAnswerReasoningEffort, getFastTextModels, getTextModels, getVisionModels, validateLlmTransportConfiguration,
  type LlmReasoningEffort,
} from "../lib/llmClient.js";
import { describeModelConfig } from "../lib/modelRegistry.js";
import { getAnswerRequestTimeoutMs, getVisionRequestTimeoutMs } from "../lib/llmTimeouts.js";
import { getAnswerMaxOutputTokens, getVisionMaxOutputTokens } from "../lib/llmOutputBudgets.js";
import { nodeProxyHint, nodeProxyStatus } from "../lib/nodeNetwork.js";
import { packageMetadata } from "../packageMetadata.js";

/**
 * Each check ends after this time even if the provider hangs. The checks run in
 * parallel, so the whole diagnosis answers inside a 60 s client timeout.
 */
const CHECK_DEADLINE_MS = 45_000;

const TEXT_DIAG_SCHEMA = {
  type: "object",
  properties: {
    result: { type: "number" },
  },
  required: ["result"],
  additionalProperties: false,
};

const DIAGNOSTIC_COLORS = ["red", "green", "blue", "yellow"] as const;
type DiagnosticColor = (typeof DIAGNOSTIC_COLORS)[number];

const VISION_DIAG_SCHEMA = {
  type: "object",
  properties: {
    dominantColor: { type: "string", enum: [...DIAGNOSTIC_COLORS] },
  },
  required: ["dominantColor"],
  additionalProperties: false,
};

/** 64x64 PNG filled with #0000ff; the prompt deliberately does not reveal the answer. */
const BLUE_DIAGNOSTIC_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAd0lEQVR4AeXBAQEAAAiDMKR/5xuE7WAjTOIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIkTuIeUTcCfmRAaTcAAAAASUVORK5CYII=";

type CheckResult = DiagnoseLlmConfigOutput["checks"][number];
type ReplyValidator = (reply: unknown) => string | undefined;

export async function diagnoseLlmConfig(options: { signal?: AbortSignal } = {}): Promise<DiagnoseLlmConfigOutput> {
  options.signal?.throwIfAborted();
  validateLlmTransportConfiguration();
  const config = describeModelConfig();
  const visionRequestTimeoutMs = getVisionRequestTimeoutMs();
  // Text checks run under the same deadline as answer_from_board, the production text path.
  const textLimits = {
    maxOutputTokens: getAnswerMaxOutputTokens(),
    requestTimeoutMs: getAnswerRequestTimeoutMs(),
    timeoutSetting: "LLM_ANSWER_REQUEST_TIMEOUT_MS",
    outputSetting: "LLM_ANSWER_MAX_OUTPUT_TOKENS",
  };
  // The text check sends the same reasoning setting as answer_from_board, so it finds a provider that rejects it.
  const answerReasoning = getAnswerReasoningEffort();

  // The checks are independent, so they run concurrently; Promise.all keeps their order.
  const checks: DiagnoseLlmConfigOutput["checks"] = await Promise.all([
    runCheck("text_json", getTextModels(), [
      {
        role: "user",
        content:
          'Calculate 17 + 25. Reply with one JSON object containing only a numeric field named "result".',
      },
    ], TEXT_DIAG_SCHEMA, expectNumericResult(42), { ...textLimits, reasoningEffort: answerReasoning }, options.signal),
    runCheck("fast_text_json", getFastTextModels(), [
      {
        role: "user",
        content:
          'Calculate 9 * 7. Reply with one JSON object containing only a numeric field named "result".',
      },
    ], TEXT_DIAG_SCHEMA, expectNumericResult(63), textLimits, options.signal),
    runCheck("vision_json", getVisionModels(), [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Inspect the attached diagnostic image. Which one of red, green, blue, or yellow is its dominant color? " +
              'Reply with one JSON object containing only a string field named "dominantColor".',
          },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${BLUE_DIAGNOSTIC_PNG}` },
          },
        ],
      },
    ], VISION_DIAG_SCHEMA, expectDominantColor("blue"),
    {
      maxOutputTokens: getVisionMaxOutputTokens(),
      requestTimeoutMs: visionRequestTimeoutMs,
      timeoutSetting: "LLM_VISION_REQUEST_TIMEOUT_MS",
      outputSetting: "LLM_VISION_MAX_OUTPUT_TOKENS",
    }, options.signal),
  ]);

  const ok = checks.every((check) => check.ok);
  const fallbacks: string[] = [];
  const retries: string[] = [];
  for (const check of checks.filter((check) => check.ok && (check.attempts?.length ?? 0) > 1)) {
    const failed = check.attempts!.filter((attempt) => !attempt.ok);
    // A router candidate is repeated once; its failed first request is a retry, not a fallback.
    const retried = failed.some((attempt) => attempt.model === check.modelUsed);
    const others = [...new Set(failed.map((attempt) => attempt.model).filter((model) => model !== check.modelUsed))];
    if (others.length) {
      fallbacks.push(`${check.name} used ${check.modelUsed}${retried ? " on its second attempt" : ""} after ${others.join(", ")} failed`);
    } else retries.push(`${check.name} passed on the second ${check.modelUsed} attempt`);
  }
  const fallbackNote = (retries.length ? ` Retry: ${retries.join("; ")}.` : "")
    + (fallbacks.length ? ` Fallback: ${fallbacks.join("; ")}.` : "");
  const network = { serverVersion: packageMetadata.version, ...nodeProxyStatus() };
  const proxyHint = nodeProxyHint(network);
  const runtime = `${packageMetadata.name} ${network.serverVersion} on Node ${network.nodeVersion}`;
  return {
    ok,
    preset: config.preset,
    visionModels: config.visionModels,
    textModels: config.textModels,
    fastTextModels: config.fastTextModels,
    providerRequireParameters: config.providerRequireParameters,
    checks,
    network,
    summary: `${runtime}\n` + (ok
      ? `LLM configuration OK (${describeActiveModels(config, checks)}).`
      : `LLM configuration has ${countChecks(checks.filter((check) => !check.ok).length)} failing.`)
      + fallbackNote + describeFailures(checks) + (proxyHint ? `\n${proxyHint}` : ""),
  };
}

function describeActiveModels(config: ReturnType<typeof describeModelConfig>, checks: CheckResult[]): string {
  const overridden = ["LLM_TEXT_MODELS", "LLM_FAST_TEXT_MODELS", "LLM_VISION_MODELS", "LLM_TEXT_MODEL", "LLM_VISION_MODEL"]
    .some((name) => process.env[name]?.trim());
  if (!overridden) return config.preset;
  const used = (name: string, models: string[]) => checks.find((check) => check.name === name)?.modelUsed ?? models.join(", ");
  const vision = used("vision_json", config.visionModels);
  const text = used("text_json", config.textModels);
  const fastText = used("fast_text_json", config.fastTextModels);
  if (vision === text && text === fastText) return text;
  return `vision: ${vision}; text: ${text}${fastText === text ? "" : `; fast text: ${fastText}`}`;
}

function countChecks(count: number): string {
  return `${count} check${count === 1 ? "" : "s"}`;
}

/** One line per cause with the failed checks it explains; many clients show only the text, not structuredContent. */
function describeFailures(checks: CheckResult[]): string {
  const byCause = new Map<string, string[]>();
  for (const check of checks.filter((check) => !check.ok)) {
    const cause = check.error ?? "cause not recorded";
    byCause.set(cause, [...(byCause.get(cause) ?? []), check.name]);
  }
  return [...byCause].map(([cause, names]) => `\n- ${names.join(", ")}: ${cause}`).join("");
}

async function runCheck(
  name: string,
  models: string[],
  messages: Parameters<typeof chatJson>[1],
  jsonSchema: Record<string, unknown>,
  validateReply: ReplyValidator,
  limits: { maxOutputTokens: number; requestTimeoutMs: number; timeoutSetting: string; outputSetting: string; reasoningEffort?: LlmReasoningEffort },
  signal?: AbortSignal,
): Promise<CheckResult> {
  signal?.throwIfAborted();
  let modelUsed: string | undefined;
  // Synthetic inputs let us show more provider detail in diagnostics.
  const attempts: Attempt[] = [];
  // The candidate whose request is running; a check deadline ends it without a reported failure.
  let pending: string | undefined;
  // One signal cancels the provider request and ends the race, even for a
  // request that ignores the abort.
  const deadline = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const aborted = new Promise<never>((_resolve, reject) => {
    requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
  });
  const timer = setTimeout(
    () => deadline.abort(new Error(`Check did not finish within ${CHECK_DEADLINE_MS / 1000} s.`)),
    CHECK_DEADLINE_MS,
  );
  const failed = (error: string): CheckResult => {
    const details = describeAttempts(attempts, error.startsWith("LLM request failed (HTTP 402):"));
    return { name, ok: false, modelUsed,
      error: details && error.startsWith("LLM request failed (HTTP 404): model ") ? `${details}; ${error}` : details ?? error,
      ...(attempts.length ? { attempts } : {}) };
  };
  try {
    const reply = await Promise.race([
      chatJson(models, messages, {
        signal: requestSignal,
        modelRole: name === "vision_json" ? "vision" : name === "fast_text_json" ? "fastText" : "text",
        requestTimeoutMs: limits.requestTimeoutMs,
        timeoutSetting: limits.timeoutSetting,
        outputSetting: limits.outputSetting,
        reasoningEffort: limits.reasoningEffort,
        maxOutputTokens: limits.maxOutputTokens,
        schemaName: `diagnose_${name}`,
        jsonSchema,
        onRequest: (model) => {
          pending = model;
        },
        onModelUsed: (model) => {
          modelUsed = model;
          pending = undefined;
        },
        onModelFailed: (model, error) => {
          attempts.push({ model, ok: false, error: redactMessage(error) });
          pending = undefined;
        },
      }),
      aborted,
    ]);

    const semanticError = validateReply(reply);
    if (modelUsed) attempts.push({ model: modelUsed, ok: !semanticError, ...(semanticError ? { error: semanticError } : {}) });
    if (semanticError) return failed(semanticError);
    return { name, ok: true, modelUsed, ...(attempts.length ? { attempts } : {}) };
  } catch (error) {
    signal?.throwIfAborted();
    const message = redactMessage(error instanceof Error ? error.message : String(error));
    if (pending) attempts.push({ model: pending, ok: false, error: message });
    return failed(message);
  } finally {
    clearTimeout(timer);
  }
}

type Attempt = NonNullable<CheckResult["attempts"]>[number];

/** Names every model of a failed check with its error. */
function describeAttempts(attempts: Attempt[], terminalPaymentError: boolean): string | undefined {
  const failures = attempts.filter((attempt) => !attempt.ok);
  if (terminalPaymentError && failures.length > 1) failures.unshift(failures.pop()!);
  return failures.length ? failures.map((attempt) => `${attempt.model}: ${attempt.error}`).join("; ") : undefined;
}

function expectNumericResult(expected: number): ReplyValidator {
  return (reply) => {
    const value = isRecord(reply) ? reply.result : undefined;
    if (!hasOnlyKey(reply, "result") || typeof value !== "number" || !Number.isFinite(value)) {
      return (
        `JSON diagnostic failed: expected exactly one numeric "result" field ` +
        `with value ${expected}, received ${formatValue(reply)}.`
      );
    }
    return value === expected
      ? undefined
      : `Semantic diagnostic failed: expected result ${expected}, received ${formatValue(value)}.`;
  };
}

function expectDominantColor(expected: DiagnosticColor): ReplyValidator {
  return (reply) => {
    const value = isRecord(reply) ? reply.dominantColor : undefined;
    if (
      !hasOnlyKey(reply, "dominantColor") ||
      typeof value !== "string" ||
      !DIAGNOSTIC_COLORS.some((color) => color === value)
    ) {
      return (
        `Vision JSON diagnostic failed: expected exactly one "dominantColor" field ` +
        `from ${DIAGNOSTIC_COLORS.join(", ")}, received ${formatValue(reply)}.`
      );
    }
    return value === expected
      ? undefined
      : `Vision diagnostic failed: expected dominant color ${expected}, received ${formatValue(value)}.`;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKey(value: unknown, expectedKey: string): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === 1 && expectedKey in value;
}

function formatValue(value: unknown): string {
  const serialized = JSON.stringify(redactOutputSecrets(value));
  return serialized === undefined ? String(value) : serialized.slice(0, 120);
}
