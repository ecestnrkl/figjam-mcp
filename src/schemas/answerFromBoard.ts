import { z } from "zod";
import { figmaFileKeySchema, questionSchema } from "./common.js";

/**
 * answer_from_board — answers a free-form question about a previously
 * ingested board, citing the clusters the answer was derived from.
 */

export const answerFromBoardInputShape = {
  boardId: figmaFileKeySchema.describe("The Figma file key returned by ingest_board"),
  question: questionSchema,
  snapshotId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
};

export const answerFromBoardInputSchema = z.object(answerFromBoardInputShape);
export type AnswerFromBoardInput = z.infer<typeof answerFromBoardInputSchema>;

export const answerFromBoardOutputShape = {
  answer: z.string(),
  citedClusters: z.array(z.string()),
  snapshotId: z.string(),
  citations: z.array(z.object({
    evidenceId: z.string(), snapshotId: z.string(), nodeId: z.string(), quote: z.string(), url: z.string(),
    sourceType: z.enum(["board_text", "table_cell", "board_metadata", "model_interpretation", "cluster_summary"]),
    modelDerived: z.boolean(), clusterId: z.string().optional(), clusterLabel: z.string().optional(),
    nodeName: z.string().max(160).optional(), pageName: z.string().max(160).optional(),
    sectionNames: z.array(z.string().max(80)).max(16).optional(),
    pageId: z.string().optional(), sectionIds: z.array(z.string()).optional(),
    row: z.number().optional(), column: z.number().optional(),
  })),
};

export const answerFromBoardOutputSchema = z.object(answerFromBoardOutputShape);
export type AnswerFromBoardOutput = z.infer<typeof answerFromBoardOutputSchema>;
