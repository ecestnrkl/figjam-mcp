/** npm run eval:retrieval [-- --with-llm [--grounding-only]]. Offline by default; only synthetic boards. */
import { performance } from "node:perf_hooks";
import { retrieveEvidence, evidenceTokens } from "../src/lib/evidence.ts";
import { retrievalFixtures } from "../tests/fixtures/retrieval.ts";
import { changeFixtures } from "../tests/fixtures/changes.ts";
import { answerGroundingFixtures } from "../tests/fixtures/answerGrounding.ts";
import { diffBoards } from "../src/lib/boardDiff.ts";

const flags = process.argv.slice(2);
if (flags.some((flag) => !["--with-llm", "--grounding-only"].includes(flag)) ||
    (flags.includes("--grounding-only") && !flags.includes("--with-llm"))) {
  console.error("Usage: npm run eval:retrieval [-- --with-llm [--grounding-only]]");
  process.exit(2);
}
const withLlm = flags.includes("--with-llm");
const groundingOnly = flags.includes("--grounding-only");
const providerCaseTimeoutMs = 45_000;
if (withLlm && (!process.env.LLM_BASE_URL?.trim() || !process.env.LLM_API_KEY?.trim())) {
  console.error("--with-llm requires explicit LLM_BASE_URL and LLM_API_KEY environment settings. Only synthetic fixtures are sent; configured providers may charge for calls.");
  process.exit(2);
}

// Disable opaque SDK retries before importing the model client. Application
// retries, JSON-format fallbacks and model fallbacks remain fully counted.
if (withLlm) process.env.LLM_SDK_MAX_RETRIES = "0";
const answerModule = withLlm ? await import("../src/tools/answerFromBoard.ts") : undefined;
const cacheModule = withLlm ? await import("../src/lib/cache.ts") : undefined;

const timings = [];
const cases = [];
const externalCases = [];
for (const fixture of retrievalFixtures) {
  // A fresh immutable board includes index construction in each measurement.
  const board = structuredClone(fixture.board);
  const start = performance.now();
  const result = retrieveEvidence(board, { query: fixture.query, limit: 3 });
  timings.push(performance.now() - start);
  const rank = fixture.expectedNodeId ? result.evidence.findIndex((item) => item.nodeId === fixture.expectedNodeId) + 1 : 0;
  cases.push({
    name: fixture.name, expectedNodeId: fixture.expectedNodeId ?? null,
    answerable: Boolean(fixture.expectedNodeId), rank,
    correctAbstention: !fixture.expectedNodeId && result.evidence.length === 0,
    legacySummaryFactVisible: legacySummaryFactVisible(fixture),
  });
  if (withLlm && !groundingOnly) externalCases.push(await evaluateAnswer(fixture, board));
}
const semanticCases = [];
for (const fixture of answerGroundingFixtures) {
  const review = {
    name: fixture.name, question: fixture.query,
    expectedStatus: fixture.expectedStatus, expectedBehavior: fixture.expectedBehavior,
    sources: fixture.board.nodes.map((node) => ({ nodeId: node.id, nodeName: node.name, text: node.text })),
    semanticReview: "required",
  };
  if (withLlm) {
    const { expectedNodeId, citesExpectedNode, abstained, ...measured } = await evaluateAnswer(fixture, structuredClone(fixture.board));
    // Citation presence is not a semantic verdict: uncertainty may correctly cite an open task.
    semanticCases.push({ ...review, ...measured });
  } else {
    semanticCases.push({ ...review, generation: "not measured (offline; no provider call)" });
  }
}
const measuredCases = withLlm ? [...externalCases, ...semanticCases] : [];
const positive = cases.filter((item) => item.answerable);
const negative = cases.filter((item) => !item.answerable);
const changeCases = changeFixtures.map((fixture) => {
  const start = performance.now();
  const diff = diffBoards(fixture.before, fixture.after);
  const elapsedMs = performance.now() - start;
  const actual = { ...Object.fromEntries(Object.keys(fixture.expected).filter((key) => key !== "tableCellChanges").map((key) => [key, diff.stats[key]])), tableCellChanges: diff.tableCellChanges.length };
  return { name: fixture.name, kind: fixture.kind, changedNodeId: fixture.changedNodeId,
    ...(fixture.changedCellId ? { changedCellId: fixture.changedCellId } : {}),
    expected: fixture.expected, actual, passed: Object.entries(fixture.expected).every(([key, value]) => actual[key] === value),
    elapsedMs: Number(elapsedMs.toFixed(3)),
  };
});
const result = {
  evaluation: "20 synthetic lexical source-retrieval fixtures; not a real-board benchmark",
  mode: withLlm ? "explicit-provider-evaluation" : "offline",
  ...(withLlm ? { providerEvaluation: {
    selection: groundingOnly ? "grounding-only" : "retrieval-and-grounding",
    selectedFixtures: measuredCases.length,
    perCaseTimeoutMs: providerCaseTimeoutMs,
  } } : {}),
  fixtures: cases.length,
  answerableFixtures: positive.length,
  unanswerableFixtures: negative.length,
  recallAt1: positive.filter((item) => item.rank === 1).length / positive.length,
  recallAt3: positive.filter((item) => item.rank > 0 && item.rank <= 3).length / positive.length,
  meanReciprocalRankAt3: positive.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / positive.length,
  correctAbstentionRate: negative.filter((item) => item.correctAbstention).length / negative.length,
  coldRetrievalMs: distribution(timings),
  baselineProxy: {
    description: "Source-fact visibility in the former deterministic first-five-texts, 120-characters-per-text summary. These fixture nodes share one spatial area. Tables had no cell text. Uses current Unicode tokens to isolate information loss; does not reproduce old ranking, vision summaries, runtime, or provider costs.",
    historicalBenchmark: false,
    visibleFacts: positive.filter((item) => item.legacySummaryFactVisible).length,
    totalFacts: positive.length,
    factVisibilityRate: positive.filter((item) => item.legacySummaryFactVisible).length / positive.length,
  },
  apiCalls: measuredCases.reduce((sum, item) => sum + item.httpAttempts, 0),
  modelQuality: withLlm ? "Structural citation validity and expected-source coverage measured below; semantic answer correctness requires human review." : "not measured (offline retrieval only)",
  modelCosts: "not measured; token counts do not imply a currency cost",
  tokenUsage: withLlm ? aggregateUsage(measuredCases.flatMap((item) => item.completions)) : "not measured (no provider calls)",
  semanticGrounding: {
    fixtures: semanticCases.length,
    generation: withLlm ? "responses collected for human review" : "not measured (offline; no provider calls)",
    semanticReview: "required",
    note: "No automatic semantic pass or score. Compare each generated answer with its original sources and expected behavior; valid citations alone do not establish a correct conclusion.",
    cases: semanticCases,
  },
  cases,
  revisions: { fixtures: changeCases.length, passed: changeCases.filter((item) => item.passed).length, diffMs: distribution(changeCases.map((item) => item.elapsedMs)), cases: changeCases },
  ...(withLlm && !groundingOnly ? { external: summarizeExternal(externalCases), externalCases } : {}),
};
console.log(JSON.stringify(result, null, 2));
if (result.recallAt1 < 1 || result.correctAbstentionRate < 1 || result.fixtures !== 20 || changeCases.some((item) => !item.passed) ||
    externalCases.some((item) => item.error || item.validCitationCount !== item.citationCount ||
      (item.expectedNodeId ? !item.citesExpectedNode : !item.abstained)) ||
    measuredCases.some((item) => item.error || item.validCitationCount !== item.citationCount)) process.exitCode = 1;

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(3)) : null;
  return { samples: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

function legacySummaryFactVisible(fixture) {
  if (!fixture.expectedNodeId) return null;
  const retained = fixture.board.nodes.filter((node) => node.type !== "TABLE" && node.text?.trim())
    .slice(0, 5).find((node) => node.id === fixture.expectedNodeId);
  if (!retained) return false;
  const original = retained.text.replace(/\s+/g, " ").trim();
  const excerpt = original.length > 120 ? original.slice(0, 117) + "..." : original;
  const retainedTokens = new Set(evidenceTokens(excerpt));
  return evidenceTokens(fixture.query).every((token) => retainedTokens.has(token));
}

async function evaluateAnswer(fixture, board) {
  cacheModule.setBoard(board.boardId, board);
  const attempts = [];
  const completions = [];
  const start = performance.now();
  const signal = AbortSignal.timeout(providerCaseTimeoutMs);
  let output;
  let error;
  try {
    output = await answerModule.answerFromBoard({ boardId: board.boardId, question: fixture.query }, {
      signal,
      onRequest: (model) => attempts.push(model),
      onUsage: (usage) => completions.push(usage),
    });
  } catch (cause) {
    // Avoid printing provider errors that may contain request data or credentials.
    error = signal.aborted ? "EvaluationTimeoutError" : cause instanceof Error ? cause.name : "UnknownError";
  }
  const citations = output?.citations ?? [];
  const sources = retrieveEvidence(board, { query: fixture.query, limit: 30, includeNeighbors: true, neighborLimit: 4 });
  const allowed = new Map(sources.evidence.map((item) => [item.evidenceId, item]));
  const validCitationCount = citations.filter((citation) => {
    const source = allowed.get(citation.evidenceId);
    const quote = citation.quote.endsWith("…") ? citation.quote.slice(0, -1) : citation.quote;
    return source && quote && source.text.startsWith(quote) && source.snapshotId === citation.snapshotId &&
      source.nodeId === citation.nodeId && source.url === citation.url && source.sourceType === citation.sourceType;
  }).length;
  return {
    name: fixture.name, expectedNodeId: fixture.expectedNodeId ?? null,
    elapsedMs: Number((performance.now() - start).toFixed(3)),
    httpAttempts: attempts.length, attemptedModels: attempts, completions,
    citationCount: citations.length, validCitationCount,
    citesExpectedNode: Boolean(fixture.expectedNodeId && citations.some((citation) => citation.nodeId === fixture.expectedNodeId)),
    abstained: Boolean(output && citations.length === 0),
    ...(output ? { answer: output.answer, citedNodeIds: citations.map((citation) => citation.nodeId) } : {}),
    ...(error ? { error } : {}),
  };
}

function aggregateUsage(completions) {
  const fields = ["promptTokens", "completionTokens", "totalTokens"];
  return {
    receivedCompletions: completions.length,
    ...Object.fromEntries(fields.map((field) => {
      const reported = completions.filter((item) => Number.isFinite(item[field]));
      return [field, { reportedSum: reported.reduce((sum, item) => sum + item[field], 0),
        reportedCompletions: reported.length, missingCompletions: completions.length - reported.length }];
    })),
    note: "Only provider-reported usage is summed. Missing usage and failed attempts may still incur charges.",
  };
}

function summarizeExternal(items) {
  const positive = items.filter((item) => item.expectedNodeId);
  const negative = items.filter((item) => !item.expectedNodeId);
  const count = items.reduce((sum, item) => sum + item.citationCount, 0);
  return {
    completedFixtures: items.filter((item) => !item.error).length,
    failedFixtures: items.filter((item) => item.error).length,
    structuralCitationValidity: count ? items.reduce((sum, item) => sum + item.validCitationCount, 0) / count : null,
    expectedSourceRecall: positive.filter((item) => item.citesExpectedNode).length / positive.length,
    correctAbstentionRate: negative.filter((item) => item.abstained).length / negative.length,
    answerLatencyMs: distribution(items.map((item) => item.elapsedMs)),
    sdkRetries: 0,
  };
}
