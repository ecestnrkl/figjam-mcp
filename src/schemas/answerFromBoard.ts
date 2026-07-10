import { z } from "zod";
import { figmaFileKeySchema, questionSchema } from "./common.js";

/**
 * answer_from_board — answers a free-form question about a previously
 * ingested board, citing the clusters the answer was derived from.
 */

export const answerFromBoardInputShape = {
  boardId: figmaFileKeySchema.describe("The Figma file key returned by ingest_board"),
  question: questionSchema,
};

export const answerFromBoardInputSchema = z.object(answerFromBoardInputShape);
export type AnswerFromBoardInput = z.infer<typeof answerFromBoardInputSchema>;

export const answerFromBoardOutputShape = {
  answer: z.string(),
  citedClusters: z.array(z.string()),
};

export const answerFromBoardOutputSchema = z.object(answerFromBoardOutputShape);
export type AnswerFromBoardOutput = z.infer<typeof answerFromBoardOutputSchema>;
