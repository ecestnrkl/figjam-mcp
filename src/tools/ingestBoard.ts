import type { IngestBoardInput, IngestBoardOutput } from "../schemas/ingestBoard.js";
import { setImmediate as yieldToRequests } from "node:timers/promises";
import { extractFigmaFileKeyFromUrl } from "../schemas/common.js";
import type { Cluster, IngestFocusReport, IngestMode, IngestQualityReport, NormalizedNode, RefinedCluster, BoardData, OperationOptions } from "../types.js";
import { fetchFileTree, fetchRenderUrls, downloadRenders, fetchFileMetadata, fetchImageRefs, downloadOriginals, FigmaApiError, FigmaDownloadBudgetError,
  FigmaTimeoutError, IMAGE_MAX_BYTES, INGEST_IMAGE_MAX_BYTES, type OriginalImage, type RenderUrls } from "../lib/figmaApi.js";
import { LLMConfigurationError, LlmInvalidJsonError, LlmRequestError, LlmTimeoutError, validateLlmConfiguration } from "../lib/llmClient.js";
import { flattenNodeTree, isGenericNodeName } from "../lib/nodeTree.js";
import { partitionedBoardClusters } from "../lib/spatialCluster.js";
import { refineClusterWithVision } from "../lib/visionInterpreter.js";
import { prepareRenders, prepareVisionImage } from "../lib/visionImages.js";
import { mapClustersToPhases } from "../lib/docStructureMapper.js";
import { buildClusterRelations, extractConnectorEdges } from "../lib/connectorGraph.js";
import { setBoard } from "../lib/cache.js";
import { redactBoard, redactNodes } from "../lib/redact.js";
import { readIntEnv } from "../lib/env.js";
import { describeModelConfig } from "../lib/modelRegistry.js";
import { sectionGuide } from "../lib/sections.js";
import { enclosingIdsLookup } from "../lib/evidence.js";
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
  EXTRACTION_VERSION,
} from "../lib/persistentCache.js";

/**
 * Max images sent to the vision model per cluster. A cluster with image fills
 * sends the originals of its largest image nodes (their content is invisible
 * in extracted text); other clusters send renders of their largest nodes. The
 * text inventory has its own hard node/character bounds in visionInterpreter.ts.
 */
const MAX_SCREENSHOTS_PER_CLUSTER = 6;
/** Image data sent per vision request; images reach the model with at most 1,024 px on the longest side. */
const VISION_REQUEST_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Many MCP clients cancel a tool call after the SDK's 60 s request timeout, and
 * a cancelled ingest persists nothing. A 40 s vision phase leaves room for the
 * Figma download, clustering and persistence; remaining clusters keep a
 * deterministic text summary and are interpreted on the next ingest.
 */
const VISION_BUDGET_MS = readIntEnv("INGEST_BOARD_VISION_BUDGET_MS", 40_000, 0);
const MIN_VISION_SLOT_MS = readIntEnv("INGEST_BOARD_MIN_VISION_SLOT_MS", 10000, 0);

/**
 * How many clusters are refined with vision concurrently. Screenshot
 * download and the LLM call dominate wall-clock time, so 2–3 in flight cuts
 * ingest latency roughly proportionally while staying inside free-tier
 * provider rate limits.
 */
const VISION_CONCURRENCY = readIntEnv("INGEST_BOARD_VISION_CONCURRENCY", 3, 1);

/**
 * Figma's image render endpoint is Tier 1 (View/Collab seats: 20 requests per
 * month; Full/Dev seats: 10–20 per minute). Image clusters therefore take their
 * originals from the Tier 2 image fills, and one request renders the
 * screenshots of several other clusters. Render time grows with the node count:
 * measured cold on a real board, 3–5 nodes took 2.6–3.5 s, 12–24 nodes 4–8 s
 * and 71 nodes 24 s, beyond the 15 s FIGMA_REQUEST_TIMEOUT_MS. 18 nodes are
 * three full clusters (one per default worker), start the first vision call
 * only seconds later than a single-cluster render, and stay well inside the
 * request timeout. Larger batches would delay every vision call of the ingest.
 */
const MAX_RENDER_BATCH_NODES = 18;

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
  if (previousBoard?.figmaVersion && previousBoard.extractionVersion === EXTRACTION_VERSION && !input.forceFullIngest) {
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
    // The previous ingest may have run with redaction off. Redaction is idempotent,
    // so already redacted nodes keep their hash, snapshot ID and cache key.
    nodes = redactNodes(previousBoard.nodes);
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
  const cacheCandidate = input.forceFullIngest ? undefined : await readCachedBoard(cacheKey, fileKey);
  const cached = cacheCandidate?.extractionVersion === EXTRACTION_VERSION ? cacheCandidate : undefined;
  if (cached && !cached.clusters.some(cluster => cluster.incomplete)) {
    const clusterNodes = clusterMembers(cached.clusters, nodes);
    // Phases follow the recomputed labels, as on a full ingest.
    const clusters = mapClustersToPhases(labelDeterministicClusters(cached.clusters, clusterNodes, nodes),
      input.docStructureHint, input.customPhases).map(cluster => ({ ...cluster, cacheHit: true }));
    const focus = resolveFocus(input.focusNodeIds, clusterNodes, nodes);
    // Cached labels and summaries may predate redaction being switched on.
    const board = redactBoard({ ...cached, clusters, freshnessCheckedAt, figmaVersion, figmaLastModified,
      createdAt: previousBoard?.snapshotId === snapshotId ? previousBoard.createdAt : Date.now(),
      qualityReport: { ...buildQualityReport(clusters, clusters.length), figmaRequests: { imageFills: 0, renders: 0 },
        ...(focus ? { focus: focusReport(focus, clusters, clusterNodes, ingestMode) } : {}) } });
    await progress("persist", 4);
    await publishBoard(board, signal);
    await complete();
    return ingestResult(board);
  }
  await progress("cluster", 2);
  const reuseBoard = cached ?? previousBoard;
  const reuseIndex = reuseBoard?.extractionVersion !== EXTRACTION_VERSION || reuseBoard?.refinementSignature !== refinementSignature
    ? new Map<string, RefinedCluster>() : buildReuseIndex(reuseBoard);
  const clusters = partitionedBoardClusters(nodes);
  if (!clusters.length) throw new Error(`Board ${fileKey} contains no content nodes to ingest`);
  const clusterNodesByIndex = clusterMembers(clusters, nodes);
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
    // forceFullIngest re-reads the board only; interpretations of unchanged clusters are kept in every mode.
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
  // Clusters within focusNodeIds come first, by their first matching ID; the usual order applies within and after them.
  const focus = resolveFocus(input.focusNodeIds, clusterNodesByIndex, nodes);
  const focusRanks = focus?.ranks ?? clusters.map(() => 0);
  visionQueue.sort((left, right) => focusRanks[left]! - focusRanks[right]!
    || retryPriorities[left]! - retryPriorities[right]!
    || compareVisionPriority(priorities[left]!, priorities[right]!));
  await progress("interpret", 3);
  const deadline = Date.now() + VISION_BUDGET_MS;
  const imageBudget = { usedBytes: 0, maxBytes: INGEST_IMAGE_MAX_BYTES };
  const imageNodes = new Map(visionQueue.map(index => [index, pickImageNodes(clusterNodesByIndex[index]!)] as const)
    .filter(([, picked]) => picked.length));
  const screenshotNodes = new Map(visionQueue.filter(index => !imageNodes.has(index))
    .map(index => [index, pickScreenshotNodes(clusterNodesByIndex[index]!)]));
  // Only clusters the budget can realistically reach share the first batches.
  const plannedClusters = MIN_VISION_SLOT_MS > 0 ? Math.floor(VISION_CONCURRENCY * VISION_BUDGET_MS / MIN_VISION_SLOT_MS) : Infinity;
  const { batches: renderBatches, plannedBatches } = planRenderBatches(visionQueue, screenshotNodes, plannedClusters);
  const figmaRequests = { imageFills: 0, renders: 0 };
  const batchOfCluster = new Map(renderBatches.flatMap((batch, number) => batch.map(index => [index, number] as const)));
  // Successful durations of this ingest: a whole cluster, and its model step alone.
  const clusterDurations: number[] = [];
  const modelDurations: number[] = [];
  const renderRequests: Array<Promise<RenderUrls>> = [];
  // Render requests are shared by several clusters, so they end with the vision
  // phase or the ingest rather than with one cluster's work.
  const renderPhase = new AbortController();
  const renderSignal = signal ? AbortSignal.any([signal, renderPhase.signal]) : renderPhase.signal;
  const renderPhaseTimer = setTimeout(() => renderPhase.abort(new VisionDeadlineExceededError()), Math.max(0, deadline - Date.now()));
  const renderBatch = (batch: number): Promise<RenderUrls> => {
    let request = renderRequests[batch];
    if (!request) {
      figmaRequests.renders++;
      request = fetchRenderUrls(fileKey, renderBatches[batch]!.flatMap(index => screenshotNodes.get(index)!), token!, renderSignal, figmaVersion);
      // Workers observe the outcome; a prefetch may end unobserved.
      request.catch(() => undefined);
      renderRequests[batch] = request;
    }
    return request;
  };
  // Stays one batch ahead of the workers, and only within the planned batches.
  const prefetchRenderBatch = (batch: number) => {
    if (batch < plannedBatches && !renderRequests[batch] && !sharedFailure &&
      hasVisionBudget(deadline, requiredSlotMs(clusterDurations))) void renderBatch(batch);
  };
  // One image fills request (Tier 2) serves every image cluster of the ingest.
  let imageFillsRequest: Promise<Record<string, string>> | undefined;
  const imageFills = (): Promise<Record<string, string>> => {
    if (!imageFillsRequest) {
      figmaRequests.imageFills++;
      imageFillsRequest = fetchImageRefs(fileKey, token!, renderSignal);
      imageFillsRequest.catch(() => undefined);
    }
    return imageFillsRequest;
  };
  let queueCursor = 0;
  let sharedFailure: { reason: VisionFallbackReason; retryAfter?: number } | undefined;
  const currentSharedFailure = (): typeof sharedFailure => sharedFailure;
  if (visionQueue.length) {
    try { validateLlmConfiguration(); }
    catch (error) { sharedFailure = { reason: classifyVisionFailure(error, "model") }; }
  }
  if (imageNodes.size && !sharedFailure && hasVisionBudget(deadline)) void imageFills();
  const fallback = (index: number, reason: VisionFallbackReason, retryAfter?: number) => {
    const members = clusterNodesByIndex[index]!;
    refined[index] = { ...refineClusterFromText(clusters[index]!, members), contentHash: contentHashes.get(clusters[index]!.id),
      incomplete: true, fallbackReason: reason, retryAfter };
  };
  /**
   * Bounded originals of an image cluster's nodes; single nodes whose original is unusable are rendered instead.
   * An original may be downloaded with up to 8 MiB because a larger one is scaled down before sending.
   */
  async function clusterImages(nodes: NormalizedNode[], imageUrls: Record<string, string>, requestSignal: AbortSignal): Promise<Buffer[]> {
    const originals: OriginalImage[] = [];
    for (const original of await downloadOriginals(nodes.map(node => imageUrls[node.imageRef!]), IMAGE_MAX_BYTES, requestSignal, imageBudget)) {
      originals.push("data" in original ? await prepareVisionImage(original.data, requestSignal) : original);
    }
    const renderIds = nodes.filter((_node, position) => "fallback" in originals[position]!).map(node => node.id);
    const renders = new Map<string, Buffer | undefined>();
    if (renderIds.length) {
      figmaRequests.renders++;
      const renderUrls = await fetchRenderUrls(fileKey, renderIds, token!, requestSignal, figmaVersion);
      (await prepareRenders(await downloadRenders(renderIds, renderUrls, requestSignal, imageBudget), requestSignal))
        .forEach((image, position) => renders.set(renderIds[position]!, image));
    }
    return withinRequestLimit(nodes.map((node, position) => {
      const original = originals[position]!;
      return "data" in original ? original.data : renders.get(node.id);
    }));
  }
  async function worker(): Promise<void> {
    while (queueCursor < visionQueue.length) {
      signal?.throwIfAborted();
      const index = visionQueue[queueCursor++]!;
      const cluster = clusters[index]!;
      const members = clusterNodesByIndex[index]!;
      if (sharedFailure) { fallback(index, sharedFailure.reason, sharedFailure.retryAfter); continue; }
      if (!hasVisionBudget(deadline, requiredSlotMs(clusterDurations))) { fallback(index, "time_budget"); continue; }
      const clusterStartedAt = Date.now();
      let stage: VisionStage = "render";
      try {
        const images = imageNodes.get(index);
        const screenshots = await withinVisionDeadline(async phaseSignal => {
          const requestSignal = signal ? AbortSignal.any([signal, phaseSignal]) : phaseSignal;
          if (images) return clusterImages(images, await imageFills(), requestSignal);
          const batch = batchOfCluster.get(index)!;
          const renderUrls = await renderBatch(batch);
          prefetchRenderBatch(batch + 1);
          return withinRequestLimit(await prepareRenders(await downloadRenders(screenshotNodes.get(index)!, renderUrls, requestSignal, imageBudget), requestSignal));
        }, deadline, signal);
        const failureAfterRendering = currentSharedFailure();
        if (failureAfterRendering) { fallback(index, failureAfterRendering.reason, failureAfterRendering.retryAfter); continue; }
        if (!hasVisionBudget(deadline, requiredSlotMs(modelDurations))) { fallback(index, "time_budget"); continue; }
        const internalEdges = internalEdgesByCluster.get(cluster.id) ?? [];
        stage = "model";
        const modelStartedAt = Date.now();
        refined[index] = { ...await withinVisionDeadline(phaseSignal => refineClusterWithVision(cluster, screenshots, members,
          signal ? AbortSignal.any([signal, phaseSignal]) : phaseSignal, internalEdges), deadline, signal),
          contentHash: contentHashes.get(cluster.id), incomplete: false };
        const finishedAt = Date.now();
        modelDurations.push(finishedAt - modelStartedAt);
        clusterDurations.push(finishedAt - clusterStartedAt);
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
  try { await Promise.all(Array.from({ length: Math.min(VISION_CONCURRENCY, visionQueue.length) }, worker)); }
  finally { clearTimeout(renderPhaseTimer); renderPhase.abort(); }
  signal?.throwIfAborted();
  const finalClusters = mapClustersToPhases(labelDeterministicClusters(refined, clusterNodesByIndex, nodes),
    input.docStructureHint, input.customPhases);
  const qualityReport = { ...buildQualityReport(finalClusters, reusedCount), reusedClusters: reusedCount, figmaRequests,
    ...(focus ? { focus: focusReport(focus, refined, clusterNodesByIndex, ingestMode) } : {}) };
  // Reused labels and summaries may predate redaction being switched on.
  const board = redactBoard({
    schemaVersion: 4, extractionVersion: EXTRACTION_VERSION, boardId: fileKey, fileKey, docStructureHint: input.docStructureHint,
    customPhases: input.customPhases, ingestMode, cacheKey, snapshotId, figmaLastModified, figmaVersion,
    freshnessCheckedAt, nodeHash, refinementSignature, modelPreset: describeModelConfig().preset,
    qualityReport, nodes, clusters: finalClusters, connectorEdges,
    clusterRelations: buildClusterRelations(connectorEdges, finalClusters),
    createdAt: previousBoard?.snapshotId === snapshotId ? previousBoard.createdAt : Date.now(),
  });
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
    summary: buildSummary(board, qualityReport) };
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

function clusterMembers(clusters: Cluster[], nodes: NormalizedNode[]): NormalizedNode[][] {
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  return clusters.map(cluster => cluster.nodeIds.map(id => nodesById.get(id)!).filter(Boolean));
}

interface Focus {
  requestedIds: string[];
  foundIds: string[];
  /** Per cluster: the position of its first matching focus ID, requestedIds.length outside the focus. */
  ranks: number[];
}

/** A cluster is in focus when one of its nodes is a focus ID or lies within one. */
function resolveFocus(focusNodeIds: string[] | undefined, clusterNodes: NormalizedNode[][], nodes: NormalizedNode[]): Focus | undefined {
  if (!focusNodeIds?.length) return undefined;
  const requestedIds = [...new Set(focusNodeIds)];
  const positions = new Map(requestedIds.map((id, position) => [id, position]));
  const enclosing = enclosingIdsLookup({ nodes });
  const nodeRank = (node: NormalizedNode) => [node.id, ...enclosing(node.id)]
    .reduce((rank, id) => Math.min(rank, positions.get(id) ?? rank), requestedIds.length);
  const known = new Set(nodes.map(node => node.id));
  return { requestedIds, foundIds: requestedIds.filter(id => known.has(id)),
    ranks: clusterNodes.map(members => members.reduce((rank, node) => Math.min(rank, nodeRank(node)), requestedIds.length)) };
}

function focusReport(focus: Focus, clusters: RefinedCluster[], clusterNodes: NormalizedNode[][], ingestMode: IngestMode): IngestFocusReport {
  const inFocus = clusters.filter((_cluster, index) => focus.ranks[index]! < focus.requestedIds.length
    && shouldUseVision(clusterNodes[index]!, ingestMode));
  const interpreted = inFocus.filter(cluster => cluster.summarySource === "vision_llm" && !cluster.incomplete).length;
  return { requestedIds: focus.requestedIds, foundIds: focus.foundIds, imageClusters: inFocus.length, interpreted,
    pending: inFocus.length - interpreted };
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

/** Chooses which cluster members to render (see MAX_SCREENSHOTS_PER_CLUSTER). */
function pickScreenshotNodes(clusterNodes: NormalizedNode[]): string[] {
  return [...clusterNodes].sort(compareNodeArea).slice(0, MAX_SCREENSHOTS_PER_CLUSTER).map((node) => node.id);
}

/** Chooses the image nodes whose originals a cluster sends (see MAX_SCREENSHOTS_PER_CLUSTER). */
function pickImageNodes(clusterNodes: NormalizedNode[]): NormalizedNode[] {
  return clusterNodes.filter(node => node.imageRef).sort(compareNodeArea).slice(0, MAX_SCREENSHOTS_PER_CLUSTER);
}

function compareNodeArea(a: NormalizedNode, b: NormalizedNode): number {
  const areaDiff = b.width * b.height - a.width * a.height;
  return areaDiff !== 0 ? areaDiff : compareStrings(a.id, b.id);
}

/**
 * Keeps images in priority order up to VISION_REQUEST_IMAGE_MAX_BYTES; the first image always stays.
 * Images that could not be bounded are left out, and a cluster without any image fails like a failed render.
 */
function withinRequestLimit(images: Array<Buffer | undefined>): Buffer[] {
  let bytes = 0;
  const kept = images.filter((image): image is Buffer => {
    if (!image || (bytes > 0 && bytes + image.byteLength > VISION_REQUEST_IMAGE_MAX_BYTES)) return false;
    bytes += image.byteLength;
    return true;
  });
  if (!kept.length) throw new Error("No image of this cluster could be prepared for the vision model");
  return kept;
}

/**
 * Splits the clusters to render, in vision queue order, into render batches of
 * whole clusters with at most MAX_RENDER_BATCH_NODES nodes. Clusters beyond the
 * planned queue position start a new batch, so they are rendered only when reached.
 */
function planRenderBatches(queue: number[], screenshotNodes: Map<number, string[]>, plannedClusters: number): { batches: number[][]; plannedBatches: number } {
  const batches: number[][] = [];
  let plannedBatches = 0;
  let batchNodes = 0;
  let batchPlanned = true;
  queue.forEach((index, position) => {
    const nodeCount = screenshotNodes.get(index)?.length;
    if (nodeCount === undefined) return;
    const planned = position < plannedClusters;
    const current = batches.at(-1);
    if (!current || batchNodes + nodeCount > MAX_RENDER_BATCH_NODES || planned !== batchPlanned) {
      batches.push([index]);
      batchNodes = nodeCount;
      batchPlanned = planned;
    } else {
      current.push(index);
      batchNodes += nodeCount;
    }
    if (planned) plannedBatches = batches.length;
  });
  return { batches, plannedBatches };
}

function hasVisionBudget(deadline: number, slotMs = MIN_VISION_SLOT_MS): boolean {
  if (VISION_BUDGET_MS <= 0) {
    return false;
  }
  const now = Date.now();
  return now < deadline && now + slotMs <= deadline;
}

/**
 * Free vision models often need longer than the minimum slot. A request cut off
 * at the deadline still costs a provider request, so a step starts only when
 * 1.25 × the median of its successful durations in this ingest still fits.
 */
function requiredSlotMs(durations: number[]): number {
  if (!durations.length) return MIN_VISION_SLOT_MS;
  const sorted = [...durations].sort((a, b) => a - b);
  const middle = sorted.length >>> 1;
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Math.max(MIN_VISION_SLOT_MS, Math.ceil(1.25 * median));
}

class VisionDeadlineExceededError extends Error {
  constructor() {
    super(`Vision phase deadline exceeded (${VISION_BUDGET_MS} ms)`);
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

  // Short text labels gain nothing from a screenshot; drawings without text do.
  return (
    clusterNodes.some((node) => node.imageRef) ||
    (totalExtractedTextLength(clusterNodes) === 0 && clusterNodes.some((node) => node.type !== "TEXT"))
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
  const imageCount = clusterNodes.filter((node) => node.imageRef).length;

  return {
    ...cluster,
    label: fallbackLabel(cluster.id, clusterNodes),
    summary: fallbackSummary(clusterNodes.length, textSnippets(clusterNodes), imageCount),
    confirmedNodeIds: [...cluster.nodeIds],
    summarySource: "deterministic",
  };
}

/**
 * Names deterministic clusters (no model label) on every ingest, including reused
 * and cached ones. A cluster with at least two text nodes in one named innermost
 * section is named after it: the section name if it is the section's only cluster,
 * else "<section>: <first text>". Other clusters take their first text or name.
 */
function labelDeterministicClusters(clusters: RefinedCluster[], clusterNodes: NormalizedNode[][],
  nodes: NormalizedNode[]): RefinedCluster[] {
  const sectionNames = new Map(nodes.filter((node) => node.type === "SECTION")
    .map((node) => [node.id, node.name.replace(/\s+/g, " ").trim()]));
  const sections = clusterNodes.map((members) => innermostSection(members, sectionNames));
  const clustersPerSection = new Map<string, number>();
  for (const id of sections) if (id) clustersPerSection.set(id, (clustersPerSection.get(id) ?? 0) + 1);
  return clusters.map((cluster, index) => {
    if (cluster.summarySource !== "deterministic" || cluster.modelId) return cluster;
    const members = clusterNodes[index]!;
    const texts = textSnippets(inReadingOrder(members));
    const sectionId = sections[index];
    if (!sectionId || texts.length < 2) return { ...cluster, label: fallbackLabel(cluster.id, members) };
    const section = sectionNames.get(sectionId)!;
    const label = clustersPerSection.get(sectionId) === 1 ? section : `${truncate(section, 40)}: ${compactLabel(texts[0]!)}`;
    return { ...cluster, label: truncate(label, 80) };
  });
}

/** The innermost section shared by all members; an unnamed section counts as none. */
function innermostSection(members: NormalizedNode[], sectionNames: Map<string, string>): string | undefined {
  const ids = new Set(members.map((node) => node.sectionIds?.at(-1)));
  const [id] = ids;
  return ids.size === 1 && id && sectionNames.get(id) ? id : undefined;
}

/** Top to bottom, then left to right; member order breaks ties. */
function inReadingOrder(nodes: NormalizedNode[]): NormalizedNode[] {
  return nodes.map((node, position) => ({ node, position }))
    .sort((a, b) => a.node.y - b.node.y || a.node.x - b.node.x || a.position - b.position)
    .map(({ node }) => node);
}

function textSnippets(nodes: NormalizedNode[]): string[] {
  return nodes.map((node) => node.text?.trim()).filter((text): text is string => Boolean(text));
}

/** The first text in reading order, else the first specific node name. */
function fallbackLabel(clusterId: string, clusterNodes: NormalizedNode[]): string {
  const ordered = inReadingOrder(clusterNodes);
  const fromText = textSnippets(ordered)[0];
  if (fromText) {
    return compactLabel(fromText);
  }

  const fromName = ordered
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

/** Boards with sections are summarized by their largest sections, the way to read them next. */
const LARGEST_SECTIONS_IN_SUMMARY = 8;

function buildSummary(board: BoardData, qualityReport: IngestQualityReport): string {
  const { fileKey, clusters, docStructureHint, ingestMode } = board;
  // get_board_context reads redactBoard(board); counting on that object builds its search index once.
  const { largestLine: largestSections, outsideSections } = sectionGuide(redactBoard(board), LARGEST_SECTIONS_IN_SUMMARY);
  const labels = clusters.map((cluster) => `"${cluster.label}"`);
  const shownLabels = labels.slice(0, 8).join(", ") + (labels.length > 8 ? ", ..." : "");
  const settings = `(docStructureHint=${docStructureHint}${ingestMode ? `, ingestMode=${ingestMode}` : ""})`;
  const overview = largestSections
    ? `${clusters.length} clusters ${settings}. ${largestSections} For overviews and summaries, read these sections with ` +
      "get_board_context and nodeIds; answer_from_board is for one specific question." +
      (outsideSections ? ` ${outsideSections} excerpt${outsideSections === 1 ? " lies" : "s lie"} outside sections; read ` +
        `${outsideSections === 1 ? "it" : "them"} with get_board_context and outsideSections: true.` : "")
    : `${clusters.length} clusters - ${shownLabels} ${settings}.`;
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
  const requests = qualityReport.figmaRequests;
  const requestNote = requests && requests.imageFills + requests.renders > 0
    ? ` Figma requests for images: ${requests.imageFills} image fills request${requests.imageFills === 1 ? "" : "s"} (Tier 2),`
      + ` ${requests.renders} render request${requests.renders === 1 ? "" : "s"} (Tier 1).` : "";
  const focusNote = qualityReport.focus ? describeFocus(qualityReport.focus, ingestMode) : "";
  return (
    `Ingested board ${fileKey}: ${overview}${cacheNote}${reuseNote}`
    + ` ${qualityReport.visionClusters} visually interpreted; ${qualityReport.deterministicClusters} use extracted text.${requestNote}${focusNote}${fallbackNote}`
  );
}

/** Unknown focus IDs named in the summary; the full list is in qualityReport.focus. */
const MISSING_FOCUS_IDS_IN_SUMMARY = 5;

function describeFocus(focus: IngestFocusReport, ingestMode?: IngestMode): string {
  const found = new Set(focus.foundIds);
  const missing = focus.requestedIds.filter(id => !found.has(id));
  const missingNote = missing.length
    ? ` ${missing.length} of ${focus.requestedIds.length} focusNodeIds not found on the board: `
      + `${missing.slice(0, MISSING_FOCUS_IDS_IN_SUMMARY).join(", ")}${missing.length > MISSING_FOCUS_IDS_IN_SUMMARY ? ", ..." : ""}.`
    : "";
  if (ingestMode === "max_speed") return ` focusNodeIds has no effect in max_speed, which interprets no images.${missingNote}`;
  const progress = !focus.imageClusters ? "Focus: no image clusters to interpret."
    : `Focus: ${focus.interpreted} of ${focus.imageClusters} image cluster${focus.imageClusters === 1 ? "" : "s"} interpreted, ${focus.pending} pending`
      + (focus.pending ? "; run ingest_board again with the same focusNodeIds to continue." : ".");
  return ` ${progress}${missingNote}`;
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
  instructions.push(reasons.time_budget || reasons.vision_budget
    ? "Run ingest_board again to continue the remaining visual interpretation; finished clusters are reused."
    : "Run ingest_board again to retry pending work; successful interpretations are kept.");
  if (!report.focus) instructions.push("To interpret the images of particular sections first, pass their section IDs as focusNodeIds.");
  return ` ${instructions.join(" ")}`;
}
