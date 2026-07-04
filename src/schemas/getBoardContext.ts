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

export const getBoardContextOutputShape = {
  contextText: z.string(),
  clusters: z.array(clusterContextSchema),
};

export const getBoardContextOutputSchema = z.object(getBoardContextOutputShape);
export type GetBoardContextOutput = z.infer<typeof getBoardContextOutputSchema>;
