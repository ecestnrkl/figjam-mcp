import type { DiagnoseLlmConfigOutput } from "../schemas/diagnoseLlmConfig.js";
import { chatJson, getFastTextModels, getTextModels, getVisionModels } from "../lib/llmClient.js";
import { describeModelConfig } from "../lib/modelRegistry.js";
import { getAnswerRequestTimeoutMs, getVisionRequestTimeoutMs } from "../lib/llmTimeouts.js";
import { ANSWER_MAX_OUTPUT_TOKENS, VISION_MAX_OUTPUT_TOKENS } from "../lib/llmOutputBudgets.js";

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

/** 64x64 PNG filled with #0066ff; the prompt deliberately does not reveal the answer. */
const BLUE_DIAGNOSTIC_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeElEQVR4nO3PQQkAMAzAwKqdfweriD2OQSACLjPn/p0XNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWvDWAst3UUt/TNtNAAAAAElFTkSuQmCC";

type CheckResult = DiagnoseLlmConfigOutput["checks"][number];
type ReplyValidator = (reply: unknown) => string | undefined;

export async function diagnoseLlmConfig(options: { signal?: AbortSignal } = {}): Promise<DiagnoseLlmConfigOutput> {
  options.signal?.throwIfAborted();
  const config = describeModelConfig();
  const visionRequestTimeoutMs = getVisionRequestTimeoutMs();
  // Text checks run under the same deadline as answer_from_board, the production text path.
  const textLimits = {
    maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
    requestTimeoutMs: getAnswerRequestTimeoutMs(),
    timeoutSetting: "LLM_ANSWER_REQUEST_TIMEOUT_MS",
  };

  // The checks are independent, so they run concurrently; Promise.all keeps their order.
  const checks: DiagnoseLlmConfigOutput["checks"] = await Promise.all([
    runCheck("text_json", getTextModels(), [
      {
        role: "user",
        content:
          'Calculate 17 + 25. Reply with one JSON object containing only a numeric field named "result".',
      },
    ], TEXT_DIAG_SCHEMA, expectNumericResult(42), textLimits, options.signal),
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
      maxOutputTokens: VISION_MAX_OUTPUT_TOKENS,
      requestTimeoutMs: visionRequestTimeoutMs,
      timeoutSetting: "LLM_VISION_REQUEST_TIMEOUT_MS",
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
  return {
    ok,
    preset: config.preset,
    visionModels: config.visionModels,
    textModels: config.textModels,
    fastTextModels: config.fastTextModels,
    providerRequireParameters: config.providerRequireParameters,
    checks,
    summary: (ok
      ? `LLM configuration OK (${config.preset}).`
      : `LLM configuration has ${checks.filter((check) => !check.ok).length} failing check(s).`) + fallbackNote,
  };
}

async function runCheck(
  name: string,
  models: string[],
  messages: Parameters<typeof chatJson>[1],
  jsonSchema: Record<string, unknown>,
  validateReply: ReplyValidator,
  limits: { maxOutputTokens: number; requestTimeoutMs: number; timeoutSetting: string },
  signal?: AbortSignal,
): Promise<CheckResult> {
  signal?.throwIfAborted();
  let modelUsed: string | undefined;
  // The checks send only synthetic data, so the provider's own message may be shown here, unlike in other tools.
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
  const failed = (error: string): CheckResult => ({ name, ok: false, modelUsed, error: describeAttempts(attempts) ?? error,
    ...(attempts.length ? { attempts } : {}) });
  try {
    const reply = await Promise.race([
      chatJson(models, messages, {
        signal: requestSignal,
        requestTimeoutMs: limits.requestTimeoutMs,
        timeoutSetting: limits.timeoutSetting,
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
          attempts.push({ model, ok: false, error });
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
    const message = error instanceof Error ? error.message : String(error);
    if (pending) attempts.push({ model: pending, ok: false, error: message });
    return failed(message);
  } finally {
    clearTimeout(timer);
  }
}

type Attempt = NonNullable<CheckResult["attempts"]>[number];

/** Names every model of a failed check with its error. */
function describeAttempts(attempts: Attempt[]): string | undefined {
  const failures = attempts.filter((attempt) => !attempt.ok);
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
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized.slice(0, 120);
}
