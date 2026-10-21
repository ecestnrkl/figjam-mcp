import { z } from "zod";
import { figmaFileKeySchema, topicSchema } from "./common.js";

/**
 * get_board_context — returns readable source excerpts as text content and the
 * same page as structured data, for a previously ingested board.
 */

export const clusterContextShape = {
  label: z.string(),
  phase: z.string().optional(),
  pageName: z.string().max(160).optional()
    .describe("Page of this cluster's excerpts on this page of results; excerpts repeat it only where they differ"),
  sectionNames: z.array(z.string().max(80)).max(16).optional()
    .describe("Enclosing sections, outermost first, of this cluster's excerpts; excerpts repeat them only where they differ"),
  summary: z.string()
    .describe("Model summary of the cluster; empty for deterministic clusters, whose excerpts carry the text"),
  summarySource: z.enum(["vision_llm", "text_llm", "deterministic", "cache", "unknown"])
    .describe("Origin of the derived cluster summary; the summary is not verbatim source evidence"),
  modelDerived: z.boolean()
    .describe("True for model summaries and summaries whose non-model origin cannot be established"),
  sourceNodeIds: z.array(z.string()).describe("Source nodes displayed on this page, not citations validating the cluster summary"),
};

export const clusterContextSchema = z.object(clusterContextShape);
export type ClusterContext = z.infer<typeof clusterContextSchema>;

export const getBoardContextInputShape = {
  boardId: figmaFileKeySchema.describe("The Figma file key returned by ingest_board"),
  topic: topicSchema.optional().describe("Optional topic to focus the context on"),
  nodeIds: z.array(z.string().trim().min(1).max(200)).min(1).max(50).optional()
    .describe("Read exact source nodes, all rows of a table or the row of a table cell, or every excerpt inside a page, section, frame or group by its ID (nested sections included, in reading order); several IDs in one call share every page in request order; cannot be combined with topic"),
  outsideSections: z.boolean().optional()
    .describe("Read every excerpt that lies in no section, cluster by cluster in reading order, tables row by row; on a board without sections, all excerpts. Cannot be combined with topic or nodeIds"),
  snapshotId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional()
    .describe("Read a specific retained snapshot instead of the latest board"),
  limit: z.number().int().min(1).max(100).default(20)
    .describe("Maximum evidence excerpts per page (default 20)"),
  cursor: z.string().min(1).max(2048).optional()
    .describe("nextCursor of the previous page, unchanged; send it with the same topic, nodeIds, outsideSections, limit and maxChars"),
  maxChars: z.number().int().min(512).max(24000).default(12000)
    .describe("Character budget for each representation: the readable text content and the JSON of structuredContent (default 12000)"),
};

export const getBoardContextInputSchema = z.object(getBoardContextInputShape).refine(
  (input) => input.topic === undefined || input.nodeIds === undefined,
  { message: "Use either topic or nodeIds, not both", path: ["nodeIds"] },
).refine(
  (input) => !input.outsideSections || (input.topic === undefined && input.nodeIds === undefined),
  { message: "Use outsideSections without topic or nodeIds", path: ["outsideSections"] },
);
export type GetBoardContextInput = z.input<typeof getBoardContextInputSchema>;

export const evidenceSchema = z.object({
  evidenceId: z.string(), snapshotId: z.string(), nodeId: z.string(), text: z.string(),
  sourceType: z.enum(["board_text", "table_cell", "table_row", "board_metadata", "model_interpretation", "cluster_summary"]),
  modelDerived: z.boolean(), clusterId: z.string().optional(), clusterLabel: z.string().optional(),
  nodeName: z.string().max(160).optional(),
  pageName: z.string().max(160).optional()
    .describe("Only for an excerpt outside the listed clusters or whose location differs from its cluster's"),
  sectionNames: z.array(z.string().max(80)).max(16).optional()
    .describe("Same rule as pageName; an empty list means outside sections"),
  pageId: z.string().optional(), sectionIds: z.array(z.string()).optional(), renderNodeId: z.string().optional(),
  row: z.number().optional(), column: z.number().optional(),
  chunkIndex: z.number().int().nonnegative(), url: z.string(), truncated: z.boolean(),
});

export const evidenceConnectionSchema = z.object({
  connectorId: z.string(), fromNodeId: z.string(),
  fromText: z.string().max(80).optional()
    .describe("Short text or name of the start node when it is not among this page's excerpts, redacted like excerpts"),
  toNodeId: z.string(),
  toText: z.string().max(80).optional()
    .describe("Short text or name of the end node when it is not among this page's excerpts, redacted like excerpts"),
  direction: z.enum(["forward", "reverse", "bidirectional", "undirected"]),
  label: z.string().optional(), url: z.string(),
});

export const clusterRelationContextShape = {
  from: z.string().describe("Label of the source cluster"),
  to: z.string().describe("Label of the target cluster"),
  label: z.string().optional().describe("Connector label(s), when the arrows are annotated"),
  edgeCount: z.number().int().positive(),
};

export const clusterRelationContextSchema = z.object(clusterRelationContextShape);
export type ClusterRelationContext = z.infer<typeof clusterRelationContextSchema>;

export const getBoardContextOutputShape = {
  contextText: z.string()
    .describe("Orientation: board header, page position, board overview or subsections. The excerpts are in evidence; the text content carries the readable version"),
  clusters: z.array(clusterContextSchema),
  snapshotId: z.string(),
  evidence: z.array(evidenceSchema),
  connections: z.array(evidenceConnectionSchema)
    .describe("Arrows with at least one end, or a section, frame or group around one, among this page's excerpts; never arrows to a page. The label is the text on the arrow"),
  totalMatched: z.number().int().nonnegative(),
  truncated: z.boolean(),
  nextCursor: z.string().optional(),
  truncation: z.object({
    remainingEvidence: z.number().int().nonnegative(),
    omittedConnections: z.number().int().nonnegative(),
    omittedRelations: z.number().int().nonnegative(),
    omittedTextConnections: z.number().int().nonnegative(),
    omittedTextRelations: z.number().int().nonnegative(),
  }).describe("Explicit omissions from structured results and the readable text"),
  relations: z
    .array(clusterRelationContextSchema)
    .optional()
    .describe("Cluster-to-cluster relations derived from connector arrows"),
};

export const getBoardContextOutputSchema = z.object(getBoardContextOutputShape);
export type GetBoardContextOutput = z.infer<typeof getBoardContextOutputSchema>;
