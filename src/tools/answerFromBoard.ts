import type {
  AnswerFromBoardInput,
  AnswerFromBoardOutput,
} from "../schemas/answerFromBoard.js";
import { getBoardOrRestore } from "../lib/cache.js";
import { formatClusterRelations } from "../lib/connectorGraph.js";
import { chatJson, getTextModels, LlmInvalidJsonError } from "../lib/llmClient.js";
import { readIntEnv } from "../lib/env.js";
import type { RefinedCluster } from "../types.js";

const ANSWER_MAX_OUTPUT_TOKENS = readIntEnv("LLM_ANSWER_MAX_OUTPUT_TOKENS", 800, 1);
const ANSWER_REPLY_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    citedClusters: { type: "array", items: { type: "string" } },
  },
  required: ["answer", "citedClusters"],
  additionalProperties: false,
};

const STOPWORDS = new Set([
  "about", "all", "and", "are", "das", "der", "die", "ein", "eine", "for",
  "geht", "gehts", "im", "in", "ist", "mit", "of", "on", "oder", "project",
  "projekt", "sind", "the", "this", "und", "um", "was", "what", "worum",
]);

/**
 * Unambiguous language markers for the extractive fallback. Deliberately
 * excludes words both languages share ("was", "in", "man", "hat" …) — only
 * words that clearly signal one language count, plus umlauts/ß as a strong
 * German signal.
 */
const GERMAN_MARKERS = new Set([
  "aber", "auch", "beim", "das", "dem", "den", "der", "doch", "ein", "eine",
  "einen", "es", "geht", "gehts", "gibt", "ist", "im", "nicht", "oder",
  "projekt", "sind", "und", "warum", "welche", "welcher", "wer", "wie",
  "wieso", "wo", "worum", "zum", "zur", "zusammenfassung", "überblick",
]);

const ENGLISH_MARKERS = new Set([
  "about", "are", "can", "did", "does", "how", "is", "it", "main", "of",
  "overview", "project", "should", "summary", "the", "there", "this", "to",
  "what", "when", "where", "which", "who", "why",
]);

/**
 * answer_from_board — answers a free-form question about an ingested board
 * (restoring the last persisted ingest after a server restart).
 *
 * Boards are small, so no vector retrieval: the full cluster context
 * (label, phase, summary per cluster) plus the connector-derived relations
 * between clusters and the question go into a single text completion. The
 * model replies with JSON so the cluster labels it used can be surfaced as
 * `citedClusters`.
 */
export async function answerFromBoard(
  input: AnswerFromBoardInput,
): Promise<AnswerFromBoardOutput> {
  const board = await getBoardOrRestore(input.boardId);
  if (!board) {
    throw new Error(
      `Board "${input.boardId}" not found in memory or on-disk cache — run ingest_board first (the boardId is the Figma file key).`,
    );
  }

  const clusterContext = board.clusters
    .map(
      (cluster) =>
        `- ${cluster.label}${cluster.phase ? ` (${cluster.phase})` : ""}: ${cluster.summary}`,
    )
    .join("\n");
  const relationLines = formatClusterRelations(board.clusterRelations ?? [], board.clusters);
  const context =
    relationLines.length > 0
      ? `${clusterContext}\n\nConnections between clusters (from connector arrows):\n${relationLines.join("\n")}`
      : clusterContext;

  let reply: unknown;
  try {
    reply = await chatJson(
      getTextModels(),
      [
        {
          role: "system",
          content:
            "You answer questions about a FigJam whiteboard using ONLY the provided cluster context. " +
            "Answer concisely and in the language of the question; do not invent information. If the context does not contain the answer, say so. " +
            "Do not explain your reasoning. Do not use markdown. " +
            'Reply with JSON only, exactly this shape: {"answer": string, "citedClusters": string[]} ' +
            "where citedClusters lists the labels of the clusters you based the answer on.",
        },
        {
          role: "user",
          content: `Board clusters:\n${context}\n\nQuestion: ${input.question}`,
        },
      ],
      {
        maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
        schemaName: "figjam_board_answer",
        jsonSchema: ANSWER_REPLY_SCHEMA,
      },
    );
  } catch (error) {
    if (error instanceof LlmInvalidJsonError) {
      console.error(
        `answer_from_board: LLM returned invalid JSON; using extractive fallback: ${error.message}`,
      );
      return answerFromBoardContext(input.question, board.clusters);
    }
    throw error;
  }

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

function answerFromBoardContext(
  question: string,
  clusters: RefinedCluster[],
): AnswerFromBoardOutput {
  const selected = selectRelevantClusters(question, clusters);
  if (selected.length === 0) {
    return {
      answer:
        isLikelyGerman(question)
          ? "Im gecachten Board-Kontext sind keine verwertbaren Cluster vorhanden."
          : "The cached board context does not contain any usable clusters.",
      citedClusters: [],
    };
  }

  const german = isLikelyGerman(question);
  const labels = formatList(selected.map((cluster) => cluster.label), german);
  const details = selected
    .map((cluster) => firstSentence(cluster.summary))
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");

  return {
    answer: german
      ? `Aus dem Board geht hervor: Das Projekt dreht sich vor allem um ${labels}. ${details}`.trim()
      : `Based on the board, the project is mainly about ${labels}. ${details}`.trim(),
    citedClusters: selected.map((cluster) => cluster.label),
  };
}

function selectRelevantClusters(question: string, clusters: RefinedCluster[]): RefinedCluster[] {
  if (clusters.length === 0) {
    return [];
  }
  if (isOverviewQuestion(question)) {
    return clusters.slice(0, 6);
  }

  const words = significantWords(question);
  if (words.length === 0) {
    return clusters.slice(0, 6);
  }

  const scored = clusters
    .map((cluster) => ({
      cluster,
      score: scoreCluster(cluster, words),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.length > 0
    ? scored.slice(0, 6).map(({ cluster }) => cluster)
    : clusters.slice(0, 6);
}

function scoreCluster(cluster: RefinedCluster, words: string[]): number {
  const label = cluster.label.toLowerCase();
  const summary = cluster.summary.toLowerCase();
  return words.reduce((score, word) => {
    const labelHit = label.includes(word) ? 2 : 0;
    const summaryHit = summary.includes(word) ? 1 : 0;
    return score + labelHit + summaryHit;
  }, 0);
}

function significantWords(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function isOverviewQuestion(question: string): boolean {
  return /\b(worum|ueberblick|überblick|zusammenfassung|summary|overview|about|project|projekt)\b/i.test(
    question,
  );
}

/**
 * Score-based language guess for the extractive fallback: umlauts/ß are a
 * strong German signal, then unambiguous marker words are counted per
 * language. Ties (or no signal) default to English — safer for an
 * international default than the old keyword regex, which classified e.g.
 * "What was the outcome?" as German because of "was".
 */
function isLikelyGerman(question: string): boolean {
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  let germanScore = /[äöüß]/i.test(question) ? 2 : 0;
  let englishScore = 0;
  for (const word of words) {
    if (GERMAN_MARKERS.has(word)) germanScore++;
    if (ENGLISH_MARKERS.has(word)) englishScore++;
  }

  return germanScore > englishScore;
}

function firstSentence(text: string): string {
  return text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
}

function formatList(values: string[], german: boolean): string {
  const unique = [...new Set(values)];
  if (unique.length <= 1) {
    return unique[0] ?? "";
  }
  const conjunction = german ? " und " : " and ";
  return `${unique.slice(0, -1).join(", ")}${conjunction}${unique.at(-1)}`;
}
