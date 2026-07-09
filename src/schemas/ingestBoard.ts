import { z } from "zod";

/**
 * ingest_board — reads a FigJam/Figma file, clusters its nodes, and caches
 * the result under a boardId for later get_board_context / answer_from_board
 * calls.
 */

export const ingestBoardInputShape = {
  figmaFileUrl: z
    .string()
    .url()
    .describe("URL of the FigJam/Figma file to ingest"),
  figmaAccessToken: z
    .string()
    .optional()
    .describe(
      "Figma personal access token; falls back to FIGMA_ACCESS_TOKEN env var if omitted",
    ),
  docStructureHint: z
    .enum(["freeform", "double_diamond", "lean_canvas", "retro", "user_journey"])
    .default("freeform")
    .describe("Built-in framework used to map clusters to phases"),
  customPhases: z
    .array(z.string().min(1))
    .max(12)
    .optional()
    .describe(
      "Free-form phase names to map clusters onto (e.g. [\"Ideen\", \"Feedback\", \"Offene Fragen\"]); overrides docStructureHint",
    ),
  ingestMode: z
    .enum(["balanced", "max_quality", "max_speed"])
    .default("balanced")
    .describe("How aggressively to use vision LLM calls during ingest"),
};

export const ingestBoardInputSchema = z.object(ingestBoardInputShape);
export type IngestBoardInput = z.infer<typeof ingestBoardInputSchema>;

export const ingestBoardOutputShape = {
  boardId: z.string(),
  clusterCount: z.number().int().nonnegative(),
  relationCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Directed cluster-to-cluster relations derived from connector arrows"),
  summary: z.string(),
  qualityReport: z
    .object({
      modelsUsed: z.array(z.string()),
      cachedClusters: z.number().int().nonnegative(),
      deterministicClusters: z.number().int().nonnegative(),
      visionClusters: z.number().int().nonnegative(),
      fallbackCount: z.number().int().nonnegative(),
    })
    .optional(),
};

export const ingestBoardOutputSchema = z.object(ingestBoardOutputShape);
export type IngestBoardOutput = z.infer<typeof ingestBoardOutputSchema>;
