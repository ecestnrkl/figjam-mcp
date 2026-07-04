import type {
  AnswerFromBoardInput,
  AnswerFromBoardOutput,
} from "../schemas/answerFromBoard.js";

/**
 * Mock handler for answer_from_board. Returns plausible placeholder data
 * shaped exactly like AnswerFromBoardOutput — no real Q&A over board
 * content yet.
 */
export async function answerFromBoard(
  input: AnswerFromBoardInput,
): Promise<AnswerFromBoardOutput> {
  return {
    answer:
      `Mock answer for board "${input.boardId}" to the question ` +
      `"${input.question}". (Real answer synthesis not implemented yet.)`,
    citedClusters: ["Problem framing", "Ideation sketches"],
  };
}
