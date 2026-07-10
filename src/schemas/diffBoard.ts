import { z } from "zod";

/**
 * diff_board — compares the two most recent ingest snapshots of a board
 * (or further back via compareTo) and reports what changed: new/removed/
 * modified clusters, node counts, and connector changes.
 */

export const diffBoardInputShape = {
  boardId: z.string().describe("The Figma file key, as returned by ingest_board"),
  compareTo: z
    .number()
    .int()
    .min(1)
    .max(19)
    .default(1)
    .describe(
      "How many snapshots back to use as the baseline (1 = the ingest before the latest)",
    ),
};

export const diffBoardInputSchema = z.object(diffBoardInputShape);
export type DiffBoardInput = z.infer<typeof diffBoardInputSchema>;

export const diffBoardOutputShape = {
  boardId: z.string(),
  baselineCreatedAt: z.string().describe("ISO timestamp of the baseline ingest"),
  currentCreatedAt: z.string().describe("ISO timestamp of the latest ingest"),
  summaryText: z.string().describe("Paste-ready human/LLM-readable change report"),
  stats: z.object({
    addedNodes: z.number().int().nonnegative(),
    removedNodes: z.number().int().nonnegative(),
    editedNodes: z.number().int().nonnegative(),
    newClusters: z.number().int().nonnegative(),
    removedClusters: z.number().int().nonnegative(),
    modifiedClusters: z.number().int().nonnegative(),
    unchangedClusters: z.number().int().nonnegative(),
    addedConnections: z.number().int().nonnegative(),
    removedConnections: z.number().int().nonnegative(),
  }),
  newClusters: z.array(z.object({ label: z.string(), summary: z.string() })),
  removedClusters: z.array(z.object({ label: z.string(), summary: z.string() })),
  modifiedClusters: z.array(
    z.object({
      label: z.string(),
      previousLabel: z.string(),
      addedNodeCount: z.number().int().nonnegative(),
      removedNodeCount: z.number().int().nonnegative(),
      editedNodeCount: z.number().int().nonnegative(),
    }),
  ),
  addedConnections: z.array(z.string()),
  removedConnections: z.array(z.string()),
};

export const diffBoardOutputSchema = z.object(diffBoardOutputShape);
export type DiffBoardOutput = z.infer<typeof diffBoardOutputSchema>;
