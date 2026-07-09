import { z } from "zod";

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
  boardId: z.string(),
  topic: z.string().optional().describe("Optional topic to focus the context on"),
};

export const getBoardContextInputSchema = z.object(getBoardContextInputShape);
export type GetBoardContextInput = z.infer<typeof getBoardContextInputSchema>;

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
  relations: z
    .array(clusterRelationContextSchema)
    .optional()
    .describe("Cluster-to-cluster relations derived from connector arrows"),
};

export const getBoardContextOutputSchema = z.object(getBoardContextOutputShape);
export type GetBoardContextOutput = z.infer<typeof getBoardContextOutputSchema>;
