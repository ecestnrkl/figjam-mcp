import type { DiagnoseLlmConfigOutput } from "../schemas/diagnoseLlmConfig.js";
import { chatJson, getTextModels, getVisionModels } from "../lib/llmClient.js";
import { describeModelConfig } from "../lib/modelRegistry.js";

const DIAG_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
  },
  required: ["ok"],
  additionalProperties: false,
};

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU9UQwAAAABJRU5ErkJggg==";

export async function diagnoseLlmConfig(): Promise<DiagnoseLlmConfigOutput> {
  const config = describeModelConfig();
  const checks: DiagnoseLlmConfigOutput["checks"] = [];

  checks.push(
    await runCheck("text_json", getTextModels(), [
      { role: "user", content: 'Reply with {"ok": true}.' },
    ]),
  );
  checks.push(
    await runCheck("vision_json", getVisionModels(), [
      {
        role: "user",
        content: [
          { type: "text", text: 'This is a 1x1 test image. Reply with {"ok": true}.' },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${ONE_PIXEL_PNG}` },
          },
        ],
      },
    ]),
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
): Promise<DiagnoseLlmConfigOutput["checks"][number]> {
  let modelUsed: string | undefined;
  try {
    await chatJson(models, messages, {
      maxOutputTokens: 100,
      schemaName: `diagnose_${name}`,
      jsonSchema: DIAG_SCHEMA,
      onModelUsed: (model) => {
        modelUsed = model;
      },
    });
    return { name, ok: true, modelUsed };
  } catch (error) {
    return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
