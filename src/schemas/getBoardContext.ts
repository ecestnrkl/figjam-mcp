import { z } from "zod";
import { figmaFileKeySchema, topicSchema } from "./common.js";

/**
 * get_board_context — returns a text summary plus the underlying clusters
 * for a previously ingested board, optionally scoped to a topic.
 */

export const clusterContextShape = {
  label: z.string(),
  phase: z.string().optional(),
  summary: z.string(),
  sourceNodeIds: z.array(z.string()),
};

export const clusterContextSchema = z.object(clusterContextShape);
export type ClusterContext = z.infer<typeof clusterContextSchema>;

export const getBoardContextInputShape = {
  boardId: figmaFileKeySchema.describe("The Figma file key returned by ingest_board"),
  topic: topicSchema.optional().describe("Optional topic to focus the context on"),
  nodeIds: z.array(z.string().trim().min(1).max(200)).min(1).max(50).optional()
    .describe("Read exact source nodes or table cells; cannot be combined with topic"),
  snapshotId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional()
    .describe("Read a specific retained snapshot instead of the latest board"),
  limit: z.number().int().min(1).max(100).default(20)
    .describe("Maximum evidence excerpts per page (default 20)"),
  cursor: z.string().min(1).max(2048).optional()
    .describe("Continue a page using the same query, snapshot, limit and maxChars"),
  maxChars: z.number().int().min(512).max(24000).default(12000)
    .describe("Character budget for the readable context (default 12000)"),
};

export const getBoardContextInputSchema = z.object(getBoardContextInputShape).refine(
  (input) => input.topic === undefined || input.nodeIds === undefined,
  { message: "Use either topic or nodeIds, not both", path: ["nodeIds"] },
);
export type GetBoardContextInput = z.input<typeof getBoardContextInputSchema>;

export const evidenceSchema = z.object({
  evidenceId: z.string(), snapshotId: z.string(), nodeId: z.string(), text: z.string(),
  sourceType: z.enum(["board_text", "table_cell", "board_metadata", "model_interpretation", "cluster_summary"]),
  modelDerived: z.boolean(), clusterId: z.string().optional(), clusterLabel: z.string().optional(),
  nodeName: z.string().max(160).optional(), pageName: z.string().max(160).optional(),
  sectionNames: z.array(z.string().max(80)).max(16).optional(),
  pageId: z.string().optional(), sectionIds: z.array(z.string()).optional(), renderNodeId: z.string().optional(),
  row: z.number().optional(), column: z.number().optional(),
  chunkIndex: z.number().int().nonnegative(), url: z.string(), truncated: z.boolean(),
});

export const evidenceConnectionSchema = z.object({
  connectorId: z.string(), fromNodeId: z.string(), toNodeId: z.string(),
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
  contextText: z.string(),
  clusters: z.array(clusterContextSchema),
  snapshotId: z.string(),
  evidence: z.array(evidenceSchema),
  connections: z.array(evidenceConnectionSchema),
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
