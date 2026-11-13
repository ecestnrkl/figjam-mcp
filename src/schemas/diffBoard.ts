import { z } from "zod";
import { boardIdInputSchema, figmaFileKeySchema, ignoredArgumentsShape } from "./common.js";

/**
 * diff_board — compares the two most recent ingest snapshots of a board
 * (or further back via compareTo) and reports what changed: new/removed/
 * modified clusters, changed nodes with their old and new text, table cells
 * and connector changes.
 */

export const diffBoardInputShape = {
  boardId: boardIdInputSchema.describe("The Figma file key, as returned by ingest_board, or the board URL"),
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

const clusterSectionSchema = z.string().optional().describe("Name of the innermost section around the cluster; absent outside sections");
const regroupedSchema = z.literal(true).optional().describe("All members exist in both snapshots");

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
    movedNodes: z.number().int().nonnegative().describe("All nodes that changed section or page, including edited nodes"),
    newClusters: z.number().int().nonnegative(),
    removedClusters: z.number().int().nonnegative(),
    modifiedClusters: z.number().int().nonnegative(),
    unchangedClusters: z.number().int().nonnegative(),
    addedConnections: z.number().int().nonnegative(),
    removedConnections: z.number().int().nonnegative(),
  }),
  newClusters: z.array(z.object({ label: z.string(), summary: z.string(), section: clusterSectionSchema, regrouped: regroupedSchema })),
  removedClusters: z.array(z.object({ label: z.string(), summary: z.string(), section: clusterSectionSchema, regrouped: regroupedSchema })),
  modifiedClusters: z.array(
    z.object({
      label: z.string(),
      previousLabel: z.string(),
      section: clusterSectionSchema,
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
    previousRow: z.number().int().nonnegative().optional().describe("0-based, as in get_board_context"),
    previousColumn: z.number().int().nonnegative().optional().describe("0-based, as in get_board_context"),
    currentRow: z.number().int().nonnegative().optional().describe("0-based, as in get_board_context"),
    currentColumn: z.number().int().nonnegative().optional().describe("0-based, as in get_board_context"),
    tableName: z.string().optional(),
    rowLabel: z.string().optional().describe("Text of the first cell in the row"),
    columnLabel: z.string().optional().describe("Text of the cell in the first row of the column"),
  })).optional(),
  nodeChanges: z.array(z.object({
    nodeId: z.string(),
    changeType: z.enum(["added", "removed", "edited", "moved"]),
    nodeType: z.string(),
    name: z.string().optional(),
    previousName: z.string().optional(),
    sectionId: z.string().optional().describe("Innermost section; absent outside sections"),
    section: z.string().optional(),
    previousSectionId: z.string().optional().describe("Origin section ID for a moved node"),
    previousSection: z.string().optional().describe("Origin section name for a moved node"),
    previousPageId: z.string().optional().describe("Origin page ID when the page changes"),
    pageId: z.string().optional().describe("Destination page ID when the page changes"),
    previousText: z.string().optional().describe("Whitespace-collapsed; only the changed part of a long text"),
    currentText: z.string().optional().describe("Whitespace-collapsed; only the changed part of a long text"),
    url: z.string(),
    changes: z.array(z.enum(["text", "name", "image", "rotation", "type", "appearance", "size", "moved"])).optional()
      .describe("Size means the node was resized; its appearance may also have changed"),
  })).optional().describe("Edited, moved, added, then removed nodes in reading order; read whole texts with get_board_context and nodeIds"),
  nodeChangesOmitted: z.number().int().positive().optional().describe("Changed nodes beyond the first 100"),
  newClustersOmitted: z.number().int().positive().optional().describe("New clusters beyond the first 20"),
  removedClustersOmitted: z.number().int().positive().optional().describe("Removed clusters beyond the first 20"),
  modifiedClustersOmitted: z.number().int().positive().optional().describe("Modified clusters beyond the first 20"),
  addedConnectionsOmitted: z.number().int().positive().optional().describe("Added connections beyond the first 50"),
  removedConnectionsOmitted: z.number().int().positive().optional().describe("Removed connections beyond the first 50"),
  tableCellChangesOmitted: z.number().int().positive().optional().describe("Table cell changes beyond the first 50"),
  ...ignoredArgumentsShape,
};

export const diffBoardOutputSchema = z.object(diffBoardOutputShape);
export type DiffBoardOutput = z.infer<typeof diffBoardOutputSchema>;
