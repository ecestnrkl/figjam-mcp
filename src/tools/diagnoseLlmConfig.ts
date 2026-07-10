import type { DiagnoseLlmConfigOutput } from "../schemas/diagnoseLlmConfig.js";
import { chatJson, getFastTextModels, getTextModels, getVisionModels } from "../lib/llmClient.js";
import { describeModelConfig } from "../lib/modelRegistry.js";

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

export async function diagnoseLlmConfig(): Promise<DiagnoseLlmConfigOutput> {
  const config = describeModelConfig();
  const checks: DiagnoseLlmConfigOutput["checks"] = [];

  checks.push(
    await runCheck("text_json", getTextModels(), [
      {
        role: "user",
        content:
          'Calculate 17 + 25. Reply with one JSON object containing only a numeric field named "result".',
      },
    ], TEXT_DIAG_SCHEMA, expectNumericResult(42)),
  );
  checks.push(
    await runCheck("fast_text_json", getFastTextModels(), [
      {
        role: "user",
        content:
          'Calculate 9 * 7. Reply with one JSON object containing only a numeric field named "result".',
      },
    ], TEXT_DIAG_SCHEMA, expectNumericResult(63)),
  );
  checks.push(
    await runCheck("vision_json", getVisionModels(), [
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
    ], VISION_DIAG_SCHEMA, expectDominantColor("blue")),
  );

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    preset: config.preset,
    visionModels: config.visionModels,
    textModels: config.textModels,
    fastTextModels: config.fastTextModels,
    providerRequireParameters: config.providerRequireParameters,
    checks,
    summary: ok
      ? `LLM configuration OK (${config.preset}).`
      : `LLM configuration has ${checks.filter((check) => !check.ok).length} failing check(s).`,
  };
}

async function runCheck(
  name: string,
  models: string[],
  messages: Parameters<typeof chatJson>[1],
  jsonSchema: Record<string, unknown>,
  validateReply: ReplyValidator,
): Promise<CheckResult> {
  let modelUsed: string | undefined;
  try {
    const reply = await chatJson(models, messages, {
      maxOutputTokens: 256,
      schemaName: `diagnose_${name}`,
      jsonSchema,
      onModelUsed: (model) => {
        modelUsed = model;
      },
    });

    const semanticError = validateReply(reply);
    if (semanticError) {
      return { name, ok: false, modelUsed, error: semanticError };
    }
    return { name, ok: true, modelUsed };
  } catch (error) {
    return {
      name,
      ok: false,
      modelUsed,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
