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
    .enum(["double_diamond", "freeform"])
    .default("freeform")
    .describe("How to interpret the board's structure when mapping clusters to phases"),
};

export const ingestBoardInputSchema = z.object(ingestBoardInputShape);
export type IngestBoardInput = z.infer<typeof ingestBoardInputSchema>;

export const ingestBoardOutputShape = {
  boardId: z.string(),
  clusterCount: z.number().int().nonnegative(),
  summary: z.string(),
};

export const ingestBoardOutputSchema = z.object(ingestBoardOutputShape);
export type IngestBoardOutput = z.infer<typeof ingestBoardOutputSchema>;
