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
      "Download and extract the board again, skipping the unchanged-board check and cache, e.g. after turning credential redaction off. Image interpretations of unchanged clusters are kept, as without forceFullIngest; clusters still pending are interpreted as on any ingest. Model and prompt changes are detected automatically, so forceFullIngest is not needed for them. An unchanged board gives no new snapshot for diff_board. Default: false",
    ),
  focusNodeIds: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(50)
    .optional()
    .describe(
      "IDs of pages, sections, frames, groups or single nodes whose image clusters are interpreted first, in list order; the rest of the board follows in the usual order. Section IDs come from the ingest_board summary or the first page of get_board_context. Only the order of image interpretation changes: the whole board is still read and cached, and later ingests without focusNodeIds reuse the interpretations. No effect in max_speed",
    ),
};

export const ingestBoardInputSchema = z.object(ingestBoardInputShape);
export type IngestBoardInput = z.infer<typeof ingestBoardInputSchema>;

export const ingestBoardOutputShape = {
  boardId: figmaFileKeySchema,
  ingestMode: z.enum(["balanced", "max_quality", "max_speed"]).optional(),
  clusterCount: z.number().int().nonnegative(),
  relationCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Directed cluster-to-cluster relations derived from connector arrows"),
  summary: z.string(),
  snapshotId: z.string().optional(),
  figmaVersion: z.string().optional(),
  freshnessCheckedAt: z.string().optional(),
  persistenceWarning: z.string().optional(),
  qualityReport: z
    .object({
      modelsUsed: z.array(z.string()),
      cachedClusters: z.number().int().nonnegative(),
      deterministicClusters: z.number().int().nonnegative(),
      visionClusters: z.number().int().nonnegative(),
      fallbackCount: z.number().int().nonnegative(),
      reusedClusters: z.number().int().nonnegative().optional(),
      incompleteClusters: z.number().int().nonnegative().optional(),
      fallbackReasons: z.record(z.string(), z.number().int().nonnegative()).optional(),
      nextRetryAt: z.number().finite().optional(),
      figmaRequests: z
        .object({ imageFills: z.number().int().nonnegative(), renders: z.number().int().nonnegative() })
        .optional()
        .describe("Figma requests of this ingest for images: image fills (Tier 2) and renders (Tier 1)"),
      focus: z
        .object({
          requestedIds: z.array(z.string()),
          foundIds: z.array(z.string()),
          imageClusters: z.number().int().nonnegative(),
          interpreted: z.number().int().nonnegative(),
          pending: z.number().int().nonnegative(),
        })
        .optional()
        .describe("Only with focusNodeIds: the IDs found on the board and the clusters in focus this ingestMode interprets, of them interpreted and pending"),
    })
    .optional(),
};

export const ingestBoardOutputSchema = z.object(ingestBoardOutputShape);
export type IngestBoardOutput = z.infer<typeof ingestBoardOutputSchema>;
