import { z } from "zod";
import { figmaFileKeySchema, figmaFileUrlSchema } from "./common.js";

/**
 * ingest_board — reads a FigJam/Figma file, clusters its nodes, and caches
 * the result under a boardId for later get_board_context / answer_from_board
 * calls.
 */

export const ingestBoardInputShape = {
  figmaFileUrl: figmaFileUrlSchema.describe("URL of the FigJam/Figma file to ingest"),
  figmaAccessToken: z
    .string()
    .trim()
    .min(1, "figmaAccessToken must not be empty")
    .max(512, "figmaAccessToken is too long")
    .optional()
    .describe(
      "Figma personal access token; falls back to FIGMA_ACCESS_TOKEN env var if omitted",
    ),
  docStructureHint: z
    .enum(["freeform", "double_diamond", "lean_canvas", "retro", "user_journey"])
    .default("freeform")
    .describe("Built-in framework used to map clusters to phases"),
  customPhases: z
    .array(
      z
        .string()
        .trim()
        .min(1, "custom phase names must not be empty")
        .max(80, "custom phase names must be at most 80 characters"),
    )
    .min(1, "customPhases must contain at least one phase when provided")
    .max(12)
    .superRefine((phases, context) => {
      const seen = new Map<string, number>();
      phases.forEach((phase, index) => {
        const canonical = phase.normalize("NFKC").toLowerCase();
        const previousIndex = seen.get(canonical);
        if (previousIndex !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: `custom phase names must be unique (duplicates phase ${previousIndex + 1})`,
          });
        } else {
          seen.set(canonical, index);
        }
      });
    })
    .optional()
    .describe(
      "Free-form phase names to map clusters onto (e.g. [\"Ideen\", \"Feedback\", \"Offene Fragen\"]); overrides docStructureHint",
    ),
  ingestMode: z
    .enum(["balanced", "max_quality", "max_speed"])
    .default("balanced")
    .describe("How aggressively to use vision LLM calls during ingest"),
  forceFullIngest: z
    .boolean()
    .optional()
    .describe(
      "Skip all caching and incremental reuse — re-refine every cluster from scratch (e.g. after changing models). Default: false",
    ),
};

export const ingestBoardInputSchema = z.object(ingestBoardInputShape);
export type IngestBoardInput = z.infer<typeof ingestBoardInputSchema>;

export const ingestBoardOutputShape = {
  boardId: figmaFileKeySchema,
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
      reusedClusters: z.number().int().nonnegative().optional(),
    })
    .optional(),
};

export const ingestBoardOutputSchema = z.object(ingestBoardOutputShape);
export type IngestBoardOutput = z.infer<typeof ingestBoardOutputSchema>;
