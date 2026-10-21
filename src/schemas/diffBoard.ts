import { z } from "zod";
import { figmaFileKeySchema } from "./common.js";

/**
 * diff_board — compares the two most recent ingest snapshots of a board
 * (or further back via compareTo) and reports what changed: new/removed/
 * modified clusters, changed nodes with their old and new text, table cells
 * and connector changes.
 */

export const diffBoardInputShape = {
  boardId: figmaFileKeySchema.describe("The Figma file key, as returned by ingest_board"),
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
  boardId: figmaFileKeySchema,
  baselineSnapshotId: z.string().optional(),
  currentSnapshotId: z.string().optional(),
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
  tableCellChanges: z.array(z.object({
    tableNodeId: z.string(),
    cellId: z.string(),
    changeType: z.enum(["added", "removed", "modified"]),
    previousText: z.string().optional(),
    currentText: z.string().optional(),
    previousRow: z.number().int().nonnegative().optional(),
    previousColumn: z.number().int().nonnegative().optional(),
    currentRow: z.number().int().nonnegative().optional(),
    currentColumn: z.number().int().nonnegative().optional(),
    tableName: z.string().optional(),
    rowLabel: z.string().optional().describe("Text of the first cell in the row"),
    columnLabel: z.string().optional().describe("Text of the cell in the first row of the column"),
  })).optional(),
  nodeChanges: z.array(z.object({
    nodeId: z.string(),
    changeType: z.enum(["added", "removed", "edited"]),
    nodeType: z.string(),
    name: z.string().optional(),
    previousName: z.string().optional(),
    sectionId: z.string().optional().describe("Innermost section; absent outside sections"),
    section: z.string().optional(),
    previousText: z.string().optional().describe("Whitespace-collapsed; only the changed part of a long text"),
    currentText: z.string().optional().describe("Whitespace-collapsed; only the changed part of a long text"),
    url: z.string(),
    changes: z.array(z.enum(["text", "name", "image", "rotation", "type", "appearance"])).optional(),
  })).optional().describe("Edited, added, then removed nodes in reading order; read whole texts with get_board_context and nodeIds"),
  nodeChangesOmitted: z.number().int().positive().optional().describe("Changed nodes beyond the first 100"),
};

export const diffBoardOutputSchema = z.object(diffBoardOutputShape);
export type DiffBoardOutput = z.infer<typeof diffBoardOutputSchema>;
