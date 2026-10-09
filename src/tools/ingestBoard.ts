import type { IngestBoardInput, IngestBoardOutput } from "../schemas/ingestBoard.js";
import { setImmediate as yieldToRequests } from "node:timers/promises";
import { extractFigmaFileKeyFromUrl } from "../schemas/common.js";
import type { Cluster, IngestMode, IngestQualityReport, NormalizedNode, RefinedCluster, BoardData, OperationOptions } from "../types.js";
import { fetchFileTree, fetchScreenshot, fetchFileMetadata, FigmaApiError, FigmaDownloadBudgetError, FigmaTimeoutError, INGEST_IMAGE_MAX_BYTES } from "../lib/figmaApi.js";
import { LLMConfigurationError, LlmInvalidJsonError, LlmRequestError, LlmTimeoutError, validateLlmConfiguration } from "../lib/llmClient.js";
import { flattenNodeTree } from "../lib/nodeTree.js";
import { partitionedBoardClusters } from "../lib/spatialCluster.js";
import { refineClusterWithVision } from "../lib/visionInterpreter.js";
import { mapClustersToPhases } from "../lib/docStructureMapper.js";
import { buildClusterRelations, extractConnectorEdges } from "../lib/connectorGraph.js";
import { setBoard } from "../lib/cache.js";
import { readIntEnv } from "../lib/env.js";
import { describeModelConfig } from "../lib/modelRegistry.js";
import {
  buildBoardCacheKey,
  extractFigmaLastModified,
  hashClusterNodes,
  hashNormalizedNodes,
  readCachedBoard,
  readLatestBoard,
  persistBoard,
  buildSnapshotId,
  getRefinementSignature,
} from "../lib/persistentCache.js";

/**
 * Max node screenshots sent to the vision model per cluster. Nodes with
 * image fills are prioritized (their content is invisible in extracted
 * text), then the largest remaining nodes. The text inventory has its own
 * hard node/character bounds in visionInterpreter.ts.
 */
const MAX_SCREENSHOTS_PER_CLUSTER = 6;

/**
 * MCP UI clients often time out a tool call before slow Figma/LLM providers do.
 * Keep the expensive vision phase inside a local budget and fall back to a
 * deterministic text summary for remaining clusters.
 */
const VISION_BUDGET_MS = readIntEnv("INGEST_BOARD_VISION_BUDGET_MS", 35000, 0);
const MIN_VISION_SLOT_MS = readIntEnv("INGEST_BOARD_MIN_VISION_SLOT_MS", 10000, 0);

/**
 * How many clusters are refined with vision concurrently. Screenshot
 * download and the LLM call dominate wall-clock time, so 2–3 in flight cuts
 * ingest latency roughly proportionally while staying inside free-tier
 * provider rate limits.
 */
const VISION_CONCURRENCY = readIntEnv("INGEST_BOARD_VISION_CONCURRENCY", 3, 1);

/**
 * ingest_board — full pipeline: fetch the Figma file, flatten + filter the
 * node tree, pre-cluster geometrically, refine each cluster with vision
 * (screenshots + text in one request), optionally map clusters onto Double
 * Diamond phases, and cache the result.
 *
 * The boardId is the Figma fileKey itself: one cache entry per file, and a
 * repeated ingest_board call simply refreshes it.
 */
const ingestQueues = new Map<string, Promise<unknown>>();

export async function ingestBoard(input: IngestBoardInput, options: OperationOptions = {}): Promise<IngestBoardOutput> {
  const fileKey = parseFigmaFileKey(input.figmaFileUrl);
  const pending = (ingestQueues.get(fileKey) ?? Promise.resolve()).catch(() => undefined)
    .then(() => performIngest(input, options));
  ingestQueues.set(fileKey, pending);
  try { return await pending; }
  finally { if (ingestQueues.get(fileKey) === pending) ingestQueues.delete(fileKey); }
}

async function performIngest(input: IngestBoardInput, options: OperationOptions): Promise<IngestBoardOutput> {
  const { signal } = options;
  const progress = async (phase: string, completed: number) => {
    // Let stdio cancellation notifications run between bounded CPU phases.
    await yieldToRequests(undefined, { signal });
    signal?.throwIfAborted();
    await options.onProgress?.(phase, completed, 5);
  };
  // Publication is the commit point. A later disconnected progress consumer
  // must not turn an already committed operation into an apparent rollback.
  const complete = async () => { try { await options.onProgress?.("complete", 5, 5); } catch { /* Best effort after commit. */ } };
  await progress("fetch", 0);
  const ingestMode = input.ingestMode ?? "balanced";
  const fileKey = parseFigmaFileKey(input.figmaFileUrl);
  const token = input.figmaAccessToken?.trim() || process.env.FIGMA_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("No Figma access token — set FIGMA_ACCESS_TOKEN in your MCP client's environment");
  const previousBoard = await readLatestBoard(fileKey);
  let nodes: NormalizedNode[];
  let figmaLastModified: string | undefined;
  let figmaVersion: string | undefined;
  let unchanged = false;
  if (previousBoard?.figmaVersion && !input.forceFullIngest) {
    try {
      const metadata = await fetchFileMetadata(fileKey, token, signal);
      unchanged = metadata.version === previousBoard.figmaVersion;
    } catch (error) {
      signal?.throwIfAborted();
      // Older tokens may not have file_metadata:read. Other failures must not
      // silently claim freshness or consume another request after a rate limit.
      if (!(error instanceof FigmaApiError && [403, 404].includes(error.status))) throw error;
    }
  }
  if (unchanged && previousBoard) {
    nodes = previousBoard.nodes;
    figmaLastModified = previousBoard.figmaLastModified;
    figmaVersion = previousBoard.figmaVersion;
  } else {
    const rawTree = await fetchFileTree(fileKey, token, signal);
    signal?.throwIfAborted();
    nodes = flattenNodeTree(rawTree);
    figmaLastModified = extractFigmaLastModified(rawTree);
    const version = (rawTree as { version?: unknown } | null)?.version;
    figmaVersion = typeof version === "string" ? version : undefined;
  }
  const freshnessCheckedAt = Date.now();
  await progress("extract", 1);
  const connectorEdges = extractConnectorEdges(nodes);
  const nodeHash = hashNormalizedNodes(nodes);
  const snapshotId = buildSnapshotId(fileKey, nodeHash);
  const refinementSignature = getRefinementSignature();
  const cacheKey = buildBoardCacheKey({ fileKey, nodeHash, docStructureHint: input.docStructureHint,
    customPhases: input.customPhases, ingestMode });
  const cached = input.forceFullIngest ? undefined : await readCachedBoard(cacheKey, fileKey);
  if (cached && !cached.clusters.some(cluster => cluster.incomplete)) {
    const clusters = cached.clusters.map(cluster => ({ ...cluster, cacheHit: true }));
    const board: BoardData = { ...cached, clusters, freshnessCheckedAt, figmaVersion, figmaLastModified,
      createdAt: previousBoard?.snapshotId === snapshotId ? previousBoard.createdAt : Date.now(),
      qualityReport: buildQualityReport(clusters, clusters.length) };
    await progress("persist", 4);
    await publishBoard(board, signal);
    await complete();
    return ingestResult(board);
  }
  await progress("cluster", 2);
  const reuseBoard = cached ?? previousBoard;
  const reuseIndex = input.forceFullIngest || reuseBoard?.refinementSignature !== refinementSignature
    ? new Map<string, RefinedCluster>() : buildReuseIndex(reuseBoard);
  const clusters = partitionedBoardClusters(nodes);
  if (!clusters.length) throw new Error(`Board ${fileKey} contains no content nodes to ingest`);
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const clusterNodesByIndex = clusters.map(cluster => cluster.nodeIds.map(id => nodesById.get(id)!).filter(Boolean));
  const contentHashes = clusterContentHashes(clusters, nodes);
  const clusterByNode = new Map(clusters.flatMap(cluster => cluster.nodeIds.map(id => [id, cluster.id] as const)));
  const internalEdgesByCluster = new Map<string, typeof connectorEdges>();
  for (const edge of connectorEdges) {
    const clusterId = clusterByNode.get(edge.fromNodeId);
    if (clusterId && clusterId === clusterByNode.get(edge.toNodeId)) {
      const group = internalEdgesByCluster.get(clusterId) ?? [];
      group.push(edge); internalEdgesByCluster.set(clusterId, group);
    }
  }
  const refined: RefinedCluster[] = new Array(clusters.length);
  const visionQueue: number[] = [];
  let reusedCount = 0;
  clusters.forEach((cluster, index) => {
    const members = clusterNodesByIndex[index]!;
    const contentHash = contentHashes.get(cluster.id)!;
    const previous = reuseIndex.get(contentHash);
    if (previous && canReusePrevious(previous, members, ingestMode)) {
      refined[index] = { ...reuseCluster(cluster, previous, contentHash), cacheHit: true };
      reusedCount++;
    } else if (shouldUseVision(members, ingestMode)) visionQueue.push(index);
    else refined[index] = { ...refineClusterFromText(cluster, members), contentHash };
  });
  const priorities = clusters.map((cluster, index) => buildVisionPriority(cluster, clusterNodesByIndex[index]!));
  // Previously deferred work must not sit behind the same failing requests on
  // every ingest. Existing cache reasons are enough; no attempt log is needed.
  const retryPriorities = clusters.map(cluster => retryPriority(reuseIndex.get(contentHashes.get(cluster.id)!)));
  visionQueue.sort((left, right) => retryPriorities[left]! - retryPriorities[right]!
    || compareVisionPriority(priorities[left]!, priorities[right]!));
  await progress("interpret", 3);
  const deadline = Date.now() + VISION_BUDGET_MS;
  const imageBudget = { usedBytes: 0, maxBytes: INGEST_IMAGE_MAX_BYTES };
  let queueCursor = 0;
  let sharedFailure: { reason: VisionFallbackReason; retryAfter?: number } | undefined;
  const currentSharedFailure = (): typeof sharedFailure => sharedFailure;
  if (visionQueue.length) {
    try { validateLlmConfiguration(); }
    catch (error) { sharedFailure = { reason: classifyVisionFailure(error, "model") }; }
  }
  const fallback = (index: number, reason: VisionFallbackReason, retryAfter?: number) => {
    const members = clusterNodesByIndex[index]!;
    refined[index] = { ...refineClusterFromText(clusters[index]!, members), contentHash: contentHashes.get(clusters[index]!.id),
      incomplete: true, fallbackReason: reason, retryAfter };
  };
  async function worker(): Promise<void> {
    while (queueCursor < visionQueue.length) {
      signal?.throwIfAborted();
      const index = visionQueue[queueCursor++]!;
      const cluster = clusters[index]!;
      const members = clusterNodesByIndex[index]!;
      if (sharedFailure) { fallback(index, sharedFailure.reason, sharedFailure.retryAfter); continue; }
      if (!hasVisionBudget(deadline)) { fallback(index, "time_budget"); continue; }
      let stage: VisionStage = "render";
      try {
        const screenshots = await withinVisionDeadline(phaseSignal => fetchScreenshot(fileKey, pickScreenshotNodes(members), token!,
          signal ? AbortSignal.any([signal, phaseSignal]) : phaseSignal, imageBudget, figmaVersion), deadline, signal);
        const failureAfterRendering = currentSharedFailure();
        if (failureAfterRendering) { fallback(index, failureAfterRendering.reason, failureAfterRendering.retryAfter); continue; }
        if (!hasVisionBudget(deadline)) { fallback(index, "time_budget"); continue; }
        const internalEdges = internalEdgesByCluster.get(cluster.id) ?? [];
        stage = "model";
        refined[index] = { ...await withinVisionDeadline(phaseSignal => refineClusterWithVision(cluster, screenshots, members,
          signal ? AbortSignal.any([signal, phaseSignal]) : phaseSignal, internalEdges), deadline, signal),
          contentHash: contentHashes.get(cluster.id), incomplete: false };
      } catch (error) {
        signal?.throwIfAborted();
        const reason = classifyVisionFailure(error, stage);
        const retryDelay = error instanceof FigmaApiError || error instanceof LlmRequestError ? error.retryAfter : undefined;
        const retryAfter = retryDelay && Number.isFinite(retryDelay) && retryDelay > 0
          ? Date.now() + retryDelay * 1000 : reason === "rate_limit" ? Date.now() + 60_000 : undefined;
        if (reason === "rate_limit" || reason === "config" || reason === "auth") sharedFailure = { reason, retryAfter };
        fallback(index, reason, retryAfter);
        console.error(`Vision refinement incomplete (${reason}); original sources are retained.`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(VISION_CONCURRENCY, visionQueue.length) }, worker));
  signal?.throwIfAborted();
  const finalClusters = mapClustersToPhases(refined, input.docStructureHint, input.customPhases);
  const qualityReport = { ...buildQualityReport(finalClusters, reusedCount), reusedClusters: reusedCount };
  const board: BoardData = {
    schemaVersion: 4, boardId: fileKey, fileKey, docStructureHint: input.docStructureHint,
    customPhases: input.customPhases, ingestMode, cacheKey, snapshotId, figmaLastModified, figmaVersion,
    freshnessCheckedAt, nodeHash, refinementSignature, modelPreset: describeModelConfig().preset,
    qualityReport, nodes, clusters: finalClusters, connectorEdges,
    clusterRelations: buildClusterRelations(connectorEdges, finalClusters),
    createdAt: previousBoard?.snapshotId === snapshotId ? previousBoard.createdAt : Date.now(),
  };
  await progress("persist", 4);
  await publishBoard(board, signal);
  await complete();
  return ingestResult(board);
}
async function publishBoard(board: BoardData, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  try { await persistBoard(board, signal); }
  catch (error) {
    signal?.throwIfAborted();
    board.persistenceWarning = "Ingest is available in this process, but persistence failed. The previous on-disk snapshot is intact; retry ingest_board.";
    console.error(board.persistenceWarning);
  }
  setBoard(board.boardId, board);
}
function ingestResult(board: BoardData): IngestBoardOutput {
  const qualityReport = board.qualityReport ?? buildQualityReport(board.clusters, 0);
  return { boardId: board.boardId, ingestMode: board.ingestMode, clusterCount: board.clusters.length,
    relationCount: board.clusterRelations?.length ?? 0, qualityReport,
    snapshotId: board.snapshotId, figmaVersion: board.figmaVersion,
    freshnessCheckedAt: board.freshnessCheckedAt === undefined ? undefined : new Date(board.freshnessCheckedAt).toISOString(),
    persistenceWarning: board.persistenceWarning,
    summary: buildSummary(board.fileKey, board.clusters, board.docStructureHint, qualityReport, board.ingestMode) };
}

type VisionStage = "render" | "model";
type VisionFallbackReason = "config" | "auth" | "rate_limit" | "timeout" | "invalid_reply"
  | "download_budget" | "render_failed" | "model_failed" | "time_budget";

function classifyVisionFailure(error: unknown, stage: VisionStage): VisionFallbackReason {
  if (error instanceof LLMConfigurationError) return "config";
  if (error instanceof FigmaDownloadBudgetError) return "download_budget";
  if (error instanceof VisionDeadlineExceededError || error instanceof FigmaTimeoutError || error instanceof LlmTimeoutError) return "timeout";
  if (error instanceof LlmInvalidJsonError) return "invalid_reply";
  if (error instanceof FigmaApiError || error instanceof LlmRequestError) {
    if (error.status === 429) return "rate_limit";
    if (error.status === 401 || error.status === 403) return "auth";
  }
  return stage === "render" ? "render_failed" : "model_failed";
}

function retryPriority(previous?: RefinedCluster): number {
  return previous?.incomplete && previous.fallbackReason !== "time_budget" && previous.fallbackReason !== "vision_budget" ? 1 : 0;
}

/**
 * Extracts the file key from a Figma/FigJam URL, e.g.
 * https://www.figma.com/board/AbC123xyz/My-Board?node-id=…  →  AbC123xyz
 */
export function parseFigmaFileKey(url: string): string {
  const fileKey = extractFigmaFileKeyFromUrl(url);
  if (!fileKey) {
    throw new Error(
      "Invalid Figma URL — expected an HTTPS figma.com URL with path " +
        "/(file|design|board|proto)/<file_key>[/name] (check the Figma file URL)",
    );
  }
  return fileKey;
}

/** Chooses which cluster members to screenshot (see MAX_SCREENSHOTS_PER_CLUSTER). */
function pickScreenshotNodes(clusterNodes: NormalizedNode[]): string[] {
  const ranked = [...clusterNodes].sort((a, b) => {
    const imageDiff = Number(Boolean(b.imageRef)) - Number(Boolean(a.imageRef));
    if (imageDiff !== 0) {
      return imageDiff;
    }
    const areaDiff = b.width * b.height - a.width * a.height;
    return areaDiff !== 0 ? areaDiff : compareStrings(a.id, b.id);
  });
  return ranked.slice(0, MAX_SCREENSHOTS_PER_CLUSTER).map((node) => node.id);
}

function hasVisionBudget(deadline: number): boolean {
  if (VISION_BUDGET_MS <= 0) {
    return false;
  }
  const now = Date.now();
  return now < deadline && now + MIN_VISION_SLOT_MS <= deadline;
}

class VisionDeadlineExceededError extends Error {
  constructor() {
    super("Vision phase deadline exceeded");
    this.name = "VisionDeadlineExceededError";
  }
}

/**
 * Bounds ingest latency and actively aborts the underlying request when the
 * phase deadline is reached. Providers may still finish already-sent work,
 * but the local HTTP request, retries, and backoff are cancelled.
 */
function withinVisionDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(new VisionDeadlineExceededError());
  }

  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    signal?.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); controller.abort(signal?.reason); reject(signal?.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      const error = new VisionDeadlineExceededError();
      signal?.removeEventListener("abort", onAbort);
      controller.abort(error);
      reject(error);
    }, remainingMs);
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
  });
}

interface VisionPriority {
  clusterId: string;
  imageCount: number;
  textLength: number;
}

function buildVisionPriority(cluster: Cluster, nodes: NormalizedNode[]): VisionPriority {
  return {
    clusterId: cluster.id,
    imageCount: nodes.filter((node) => Boolean(node.imageRef)).length,
    textLength: totalExtractedTextLength(nodes),
  };
}

function compareVisionPriority(left: VisionPriority, right: VisionPriority): number {
  const imagePresenceDiff = Number(right.imageCount > 0) - Number(left.imageCount > 0);
  if (imagePresenceDiff !== 0) {
    return imagePresenceDiff;
  }

  const textLengthDiff = left.textLength - right.textLength;
  if (textLengthDiff !== 0) {
    return textLengthDiff;
  }

  const imageCountDiff = right.imageCount - left.imageCount;
  if (imageCountDiff !== 0) {
    return imageCountDiff;
  }

  return compareStrings(left.clusterId, right.clusterId);
}

function totalExtractedTextLength(nodes: NormalizedNode[]): number {
  return nodes.reduce((total, node) => total + (node.text?.trim().length ?? 0), 0);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function shouldUseVision(clusterNodes: NormalizedNode[], ingestMode: IngestMode): boolean {
  if (ingestMode === "max_speed") {
    return false;
  }
  if (ingestMode === "max_quality") {
    return true;
  }

  return (
    clusterNodes.some((node) => node.imageRef) ||
    totalExtractedTextLength(clusterNodes) < 40
  );
}

/**
 * Indexes the previous ingest's refined clusters by the content hash of
 * their member nodes. Hashes are recomputed from the previous board's node
 * list (rather than trusting stored contentHash values), so boards ingested
 * by older versions work too.
 */
function clusterContentHashes(clusters: Cluster[], allNodes: NormalizedNode[]): Map<string, string> {
  const clusterByNode = new Map<string, string>();
  const content = new Map<string, NormalizedNode[]>();
  for (const cluster of clusters) {
    content.set(cluster.id, []);
    for (const id of cluster.nodeIds) clusterByNode.set(id, cluster.id);
  }
  for (const node of allNodes) {
    const clusterId = clusterByNode.get(node.id);
    if (clusterId) content.get(clusterId)!.push(node);
    else if (node.type === "CONNECTOR" && node.connectorStartId && node.connectorEndId) {
      const owner = clusterByNode.get(node.connectorStartId);
      if (owner && owner === clusterByNode.get(node.connectorEndId)) content.get(owner)!.push(node);
    }
  }
  return new Map([...content].map(([id, nodes]) => [id, hashClusterNodes(nodes)]));
}

function buildReuseIndex(previous?: BoardData): Map<string, RefinedCluster> {
  const index = new Map<string, RefinedCluster>();
  if (!previous) return index;
  const hashes = clusterContentHashes(previous.clusters, previous.nodes);
  for (const cluster of previous.clusters) {
    const hash = hashes.get(cluster.id);
    if (hash && cluster.nodeIds.length) index.set(hash, cluster);
  }
  return index;
}

/**
 * A previous refinement is reused when it is at least as good as what this
 * ingest would produce for the cluster:
 * - vision summaries are always kept (except max_quality re-runs get the
 *   chance to upgrade non-vision leftovers),
 * - deterministic summaries are only kept when this ingest would also skip
 *   vision — otherwise the cluster gets its overdue vision refinement.
 */
function canReusePrevious(
  previous: RefinedCluster,
  clusterNodes: NormalizedNode[],
  ingestMode: IngestMode,
): boolean {
  if (previous.incomplete) return shouldUseVision(clusterNodes, ingestMode)
    && previous.retryAfter !== undefined && previous.retryAfter > Date.now();
  if (previous.summarySource === "vision_llm") {
    return true;
  }
  return !shouldUseVision(clusterNodes, ingestMode);
}

/** Carries a previous refinement over to the freshly clustered geometry. */
function reuseCluster(
  cluster: Cluster,
  previous: RefinedCluster,
  contentHash: string,
): RefinedCluster {
  const valid = new Set(cluster.nodeIds);
  const confirmed = previous.confirmedNodeIds.filter((id) => valid.has(id));
  return {
    ...cluster,
    label: previous.label,
    summary: previous.summary,
    confirmedNodeIds: confirmed.length > 0 ? confirmed : [...cluster.nodeIds],
    summarySource: previous.summarySource,
    modelId: previous.modelId,
    incomplete: previous.incomplete,
    fallbackReason: previous.fallbackReason,
    retryAfter: previous.retryAfter,
    contentHash,
  };
}

function refineClusterFromText(cluster: Cluster, clusterNodes: NormalizedNode[]): RefinedCluster {
  const textSnippets = clusterNodes
    .map((node) => node.text?.trim())
    .filter((text): text is string => Boolean(text));
  const imageCount = clusterNodes.filter((node) => node.imageRef).length;

  return {
    ...cluster,
    label: fallbackLabel(cluster.id, textSnippets, clusterNodes),
    summary: fallbackSummary(clusterNodes.length, textSnippets, imageCount),
    confirmedNodeIds: [...cluster.nodeIds],
    summarySource: "deterministic",
  };
}

function fallbackLabel(
  clusterId: string,
  textSnippets: string[],
  clusterNodes: NormalizedNode[],
): string {
  const fromText = textSnippets.find((text) => text.length > 0);
  if (fromText) {
    return compactLabel(fromText);
  }

  const fromName = clusterNodes
    .map((node) => node.name.trim())
    .find((name) => name && !isGenericNodeName(name));
  return fromName ? compactLabel(fromName) : `Cluster ${clusterId.replace(/^cluster_/, "")}`;
}

function fallbackSummary(
  nodeCount: number,
  textSnippets: string[],
  imageCount: number,
): string {
  const textCount = textSnippets.length;
  const parts = [
    `Cluster contains ${nodeCount} board element${nodeCount === 1 ? "" : "s"} with ${textCount} extracted text item${textCount === 1 ? "" : "s"}.`,
  ];

  const highlights = textSnippets.slice(0, 5).map((text) => `"${truncate(text, 120)}"`);
  if (highlights.length > 0) {
    parts.push(`Extracted text highlights: ${highlights.join("; ")}.`);
  } else {
    parts.push("No readable text was extracted from this cluster.");
  }

  if (imageCount > 0) {
    parts.push(
      `It includes ${imageCount} image element${imageCount === 1 ? "" : "s"} that have not been visually interpreted in this summary.`,
    );
  }

  parts.push("The source node IDs are retained for follow-up context.");
  return parts.join(" ");
}

function compactLabel(text: string): string {
  const normalized = text.replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
  const words = normalized.split(" ").filter(Boolean).slice(0, 6).join(" ");
  return truncate(words || normalized, 60);
}

function isGenericNodeName(name: string): boolean {
  return /^(sticky|text|rectangle|ellipse|shape|connector|section|group|frame|table)( \d+)?$/i.test(
    name,
  );
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function buildQualityReport(
  clusters: RefinedCluster[],
  cachedClusters: number,
): IngestQualityReport {
  const modelsUsed = [
    ...new Set(
      clusters
        .map((cluster) => cluster.modelId)
        .filter((modelId): modelId is string => Boolean(modelId)),
    ),
  ];
  const incomplete = clusters.filter(cluster => cluster.incomplete);
  const fallbackReasons: Record<string, number> = {};
  for (const cluster of incomplete) {
    const reason = cluster.fallbackReason ?? "unknown";
    fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
  }
  const pendingRetryTimes = incomplete.map(cluster => cluster.retryAfter)
    .filter((time): time is number => time !== undefined && time > Date.now() && time <= 8.64e15);
  return {
    modelsUsed,
    cachedClusters,
    deterministicClusters: clusters.filter((cluster) => cluster.summarySource === "deterministic")
      .length,
    visionClusters: clusters.filter((cluster) => cluster.summarySource === "vision_llm").length,
    fallbackCount: incomplete.length,
    incompleteClusters: incomplete.length,
    fallbackReasons,
    ...(pendingRetryTimes.length ? { nextRetryAt: pendingRetryTimes.reduce((earliest, time) => Math.min(earliest, time), Infinity) } : {}),
  };
}

function buildSummary(
  fileKey: string,
  clusters: RefinedCluster[],
  docStructureHint: IngestBoardInput["docStructureHint"],
  qualityReport: IngestQualityReport,
  ingestMode?: IngestMode,
): string {
  const labels = clusters.map((cluster) => `"${cluster.label}"`);
  const shownLabels = labels.slice(0, 8).join(", ") + (labels.length > 8 ? ", ..." : "");
  const fallbackNote =
    qualityReport.fallbackCount > 0
      ? ` Visual interpretation is incomplete for ${qualityReport.fallbackCount} cluster${qualityReport.fallbackCount === 1 ? "" : "s"}: ${describeFallbackReasons(qualityReport.fallbackReasons)}.`
        + ` Original extracted texts, tables and node references remain available for search.`
        + describeNextSteps(qualityReport)
      : "";
  const cacheNote =
    qualityReport.cachedClusters > 0 ? ` Loaded ${qualityReport.cachedClusters} clusters from cache.` : "";
  const reuseNote =
    (qualityReport.reusedClusters ?? 0) > 0
      ? ` Reused ${qualityReport.reusedClusters} unchanged cluster${qualityReport.reusedClusters === 1 ? "" : "s"} from the previous ingest.`
      : "";
  return (
    `Ingested board ${fileKey}: ${clusters.length} clusters - ${shownLabels} ` +
    `(docStructureHint=${docStructureHint}${ingestMode ? `, ingestMode=${ingestMode}` : ""}).${cacheNote}${reuseNote}`
    + ` ${qualityReport.visionClusters} visually interpreted; ${qualityReport.deterministicClusters} use extracted text.${fallbackNote}`
  );
}

function describeFallbackReasons(reasons?: Record<string, number>): string {
  const labels: Record<string, string> = {
    time_budget: "deferred by the vision time budget", vision_budget: "deferred by the previous vision budget",
    timeout: "requests timed out", config: "blocked by missing or invalid model configuration",
    auth: "blocked by Figma or model access permissions", rate_limit: "blocked by a provider rate limit",
    invalid_reply: "model replies were unusable", download_budget: "exceeded image download limits",
    render_failed: "Figma rendering or image download failed", model_failed: "model requests failed",
    vision_failed: "older cached failures (cause not recorded)", unknown: "failures with no recorded cause",
  };
  return Object.entries(reasons ?? {}).filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${labels[reason] ?? labels.unknown}`).join("; ") || "cause not recorded";
}

function describeNextSteps(report: IngestQualityReport): string {
  const reasons = report.fallbackReasons ?? {};
  const instructions: string[] = [];
  if (reasons.config) instructions.push("Set LLM_API_KEY and LLM_BASE_URL in the MCP client environment, then reconnect. diagnose_llm_config can test the configured model provider.");
  if (reasons.auth) instructions.push("Check Figma and model-provider access permissions; diagnose_llm_config can test the configured model provider.");
  if (report.nextRetryAt) instructions.push(`Retry after ${new Date(report.nextRetryAt).toISOString()} for the pending provider cooldown.`);
  instructions.push("Re-ingest without forceFullIngest to retain successful interpretations and retry pending work.");
  return ` ${instructions.join(" ")}`;
}
