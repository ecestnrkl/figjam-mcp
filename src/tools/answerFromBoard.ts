import type {
  AnswerFromBoardInput,
  AnswerFromBoardOutput,
} from "../schemas/answerFromBoard.js";
import { getBoard } from "../lib/cache.js";
import { chatJson, getTextModel } from "../lib/llmClient.js";

/**
 * answer_from_board — answers a free-form question about an ingested board.
 *
 * Boards are small, so no vector retrieval: the full cluster context
 * (label, phase, summary per cluster) plus the question go into a single
 * text completion. The model replies with JSON so the cluster labels it
 * used can be surfaced as `citedClusters`.
 */
export async function answerFromBoard(
  input: AnswerFromBoardInput,
): Promise<AnswerFromBoardOutput> {
  const board = getBoard(input.boardId);
  if (!board) {
    throw new Error(
      `Board "${input.boardId}" not found — run ingest_board first (the boardId is the Figma file key).`,
    );
  }

  const context = board.clusters
    .map(
      (cluster) =>
        `- ${cluster.label}${cluster.phase ? ` (${cluster.phase})` : ""}: ${cluster.summary}`,
    )
    .join("\n");

  const reply = await chatJson(getTextModel(), [
    {
      role: "system",
      content:
        "You answer questions about a FigJam whiteboard using ONLY the provided cluster context. " +
        "Answer concisely; do not invent information. If the context does not contain the answer, say so. " +
        'Reply with JSON only, exactly this shape: {"answer": string, "citedClusters": string[]} ' +
        "where citedClusters lists the labels of the clusters you based the answer on.",
    },
    {
      role: "user",
      content: `Board clusters:\n${context}\n\nQuestion: ${input.question}`,
    },
  ]);

  const parsed = reply as { answer?: unknown; citedClusters?: unknown } | null;
  if (typeof parsed?.answer !== "string" || !parsed.answer.trim()) {
    throw new Error('LLM reply for answer_from_board is missing "answer"');
  }

  // Only cite labels that actually exist on the board (case-insensitive
  // match, mapped back to the canonical label).
  const canonical = new Map(
    board.clusters.map((cluster) => [cluster.label.toLowerCase(), cluster.label]),
  );
  const citedClusters = Array.isArray(parsed.citedClusters)
    ? parsed.citedClusters
        .filter((label): label is string => typeof label === "string")
        .map((label) => canonical.get(label.toLowerCase()))
        .filter((label): label is string => label !== undefined)
    : [];

  return { answer: parsed.answer.trim(), citedClusters: [...new Set(citedClusters)] };
}
