import { z } from "zod";

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
    }),
  ),
  summary: z.string(),
};

export const diagnoseLlmConfigOutputSchema = z.object(diagnoseLlmConfigOutputShape);
export type DiagnoseLlmConfigOutput = z.infer<typeof diagnoseLlmConfigOutputSchema>;
