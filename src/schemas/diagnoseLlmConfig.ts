import { z } from "zod";
import { ignoredArgumentsShape } from "./common.js";

export const diagnoseLlmConfigInputShape = {};

export const diagnoseLlmConfigInputSchema = z.object(diagnoseLlmConfigInputShape);
export type DiagnoseLlmConfigInput = z.infer<typeof diagnoseLlmConfigInputSchema>;

export const diagnoseLlmConfigOutputShape = {
  ok: z.boolean(),
  preset: z.string(),
  visionModels: z.array(z.string()),
  textModels: z.array(z.string()),
  fastTextModels: z.array(z.string()),
  providerRequireParameters: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      modelUsed: z.string().optional(),
      error: z.string().optional(),
      attempts: z
        .array(z.object({ model: z.string(), ok: z.boolean(), error: z.string().optional() }))
        .optional()
        .describe("The model candidates tried, in order; error is the provider's message or the error"),
    }),
  ),
  summary: z.string(),
  network: z.object({
    nodeVersion: z.string(),
    proxyConfigured: z.boolean(),
    proxyActive: z.boolean(),
  }).optional().describe("Node.js version and environment proxy status, without proxy values"),
  ...ignoredArgumentsShape,
};

export const diagnoseLlmConfigOutputSchema = z.object(diagnoseLlmConfigOutputShape);
export type DiagnoseLlmConfigOutput = z.infer<typeof diagnoseLlmConfigOutputSchema>;
