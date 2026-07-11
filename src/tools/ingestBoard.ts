import type { IngestBoardInput, IngestBoardOutput } from "../schemas/ingestBoard.js";
import { extractFigmaFileKeyFromUrl } from "../schemas/common.js";
import type { Cluster, IngestMode, IngestQualityReport, NormalizedNode, RefinedCluster } from "../types.js";
import { fetchFileTree, fetchScreenshot } from "../lib/figmaApi.js";
import { flattenNodeTree } from "../lib/nodeTree.js";
import { geometricPreCluster } from "../lib/spatialCluster.js";
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
  writeBoardHistoryEntry,
  writeCachedBoard,
  writeLatestBoardPointer,
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
export async function ingestBoard(input: IngestBoardInput): Promise<IngestBoardOutput> {
  const ingestMode = input.ingestMode ?? "balanced";
  const fileKey = parseFigmaFileKey(input.figmaFileUrl);
  const token = input.figmaAccessToken?.trim() || process.env.FIGMA_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "No Figma access token — pass figmaAccessToken or set FIGMA_ACCESS_TOKEN in .env",
    );
  }

  const rawTree = await fetchFileTree(fileKey, token);
  const nodes = flattenNodeTree(rawTree);
  const connectorEdges = extractConnectorEdges(nodes);
  const figmaLastModified = extractFigmaLastModified(rawTree);
  const nodeHash = hashNormalizedNodes(nodes);
  const cacheKey = buildBoardCacheKey({
    fileKey,
    figmaLastModified,
    nodeHash,
    docStructureHint: input.docStructureHint,
    customPhases: input.customPhases,
    ingestMode,
  });
  const cached = input.forceFullIngest ? undefined : await readCachedBoard(cacheKey);
  if (cached) {
    const clusters = cached.clusters.map((cluster) => ({
      ...cluster,
      summarySource: "cache" as const,
    }));
    const qualityReport = buildQualityReport(clusters, clusters.length);
    setBoard(fileKey, {
      ...cached,
      clusters,
      createdAt: Date.now(),
      qualityReport,
    });
    await writeLatestBoardPointer(fileKey, cacheKey);
    await writeBoardHistoryEntry(fileKey, { cacheKey, nodeHash, createdAt: Date.now() });
    return {
      boardId: fileKey,
      clusterCount: clusters.length,
      relationCount: cached.clusterRelations?.length ?? 0,
      qualityReport,
      summary: buildSummary(fileKey, clusters, input.docStructureHint, qualityReport),
    };
  }

  // Incremental reuse: index the previous ingest's refinements by cluster
  // content hash. Clusters whose member content is unchanged skip the
  // expensive vision step entirely and keep their label/summary.
  const reuseIndex = input.forceFullIngest
    ? new Map<string, RefinedCluster>()
    : await buildReuseIndex(fileKey);

  const clusters = geometricPreCluster(selectClusterableNodes(nodes));

  if (clusters.length === 0) {
    throw new Error(`Board ${fileKey} contains no content nodes to ingest`);
  }

  // Refine clusters while the MCP-safe vision budget allows it; remaining
  // clusters still get deterministic text summaries and are cached. Vision
  // candidates run through a small concurrent worker pool (screenshot fetch
  // + LLM call dominate latency); results land at their original index so
  // cluster order stays stable regardless of completion order.
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const clusterNodesOf = (cluster: Cluster): NormalizedNode[] =>
    cluster.nodeIds
      .map((id) => nodesById.get(id))
      .filter((node): node is NormalizedNode => node !== undefined);
  const clusterNodesByIndex = clusters.map(clusterNodesOf);

  const refined: RefinedCluster[] = new Array(clusters.length);
  const visionQueue: number[] = [];
  let reusedCount = 0;
  clusters.forEach((cluster, index) => {
    const clusterNodes = clusterNodesByIndex[index]!;
    const contentHash = hashClusterNodes(clusterNodes);

    const previous = reuseIndex.get(contentHash);
    if (previous && canReusePrevious(previous, clusterNodes, ingestMode)) {
      refined[index] = reuseCluster(cluster, previous, contentHash);
      reusedCount++;
      return;
    }

    if (shouldUseVision(clusterNodes, ingestMode)) {
      visionQueue.push(index);
    } else {
      refined[index] = { ...refineClusterFromText(cluster, clusterNodes), contentHash };
    }
  });

  // The queue is deliberately independent of canvas order. Image-backed
  // clusters carry information that cannot be recovered from the Figma text
  // tree, while low-text clusters benefit more from visual interpretation
  // than already well-described ones. Stable tie-breakers keep the result
  // deterministic across runs.
  const visionPriorities = clusters.map((cluster, index) =>
    buildVisionPriority(cluster, clusterNodesByIndex[index]!),
  );
  visionQueue.sort((left, right) =>
    compareVisionPriority(visionPriorities[left]!, visionPriorities[right]!),
  );

  // Start the budget when the vision phase actually begins. Slow Figma file
  // downloads and geometric clustering must not consume time intended for
  // screenshots and visual interpretation.
  const visionDeadline = Date.now() + VISION_BUDGET_MS;

  let fallbackCount = 0;
  let queueCursor = 0;
  const visionWorker = async (): Promise<void> => {
    while (queueCursor < visionQueue.length) {
      const index = visionQueue[queueCursor++]!;
      const cluster = clusters[index]!;
      const clusterNodes = clusterNodesByIndex[index]!;
      const contentHash = hashClusterNodes(clusterNodes);

      if (!hasVisionBudget(visionDeadline)) {
        refined[index] = { ...refineClusterFromText(cluster, clusterNodes), contentHash };
        fallbackCount++;
        continue;
      }

      try {
        const screenshots = await withinVisionDeadline(
          (signal) =>
            fetchScreenshot(fileKey, pickScreenshotNodes(clusterNodes), token, signal),
          visionDeadline,
        );

        // Screenshot rendering/downloading can itself consume the remaining
        // budget. Re-check before the expensive LLM request so no new model
        // work starts once the phase deadline (or minimum useful slot) has
        // elapsed.
        if (!hasVisionBudget(visionDeadline)) {
          refined[index] = { ...refineClusterFromText(cluster, clusterNodes), contentHash };
          fallbackCount++;
          continue;
        }

        const visionRefinement = await withinVisionDeadline(
          (signal) => refineClusterWithVision(cluster, screenshots, clusterNodes, signal),
          visionDeadline,
        );
        refined[index] = {
          ...visionRefinement,
          contentHash,
        };
      } catch (error) {
        if (!(error instanceof VisionDeadlineExceededError)) {
          console.error(
            `Vision refinement failed for ${cluster.id}; using text fallback: ${errorMessage(error)}`,
          );
        }
        refined[index] = { ...refineClusterFromText(cluster, clusterNodes), contentHash };
        fallbackCount++;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(VISION_CONCURRENCY, visionQueue.length) }, visionWorker),
  );

  const finalClusters = mapClustersToPhases(refined, input.docStructureHint, input.customPhases);
  const clusterRelations = buildClusterRelations(connectorEdges, finalClusters);
  const qualityReport = {
    ...buildQualityReport(finalClusters, 0),
    fallbackCount,
    reusedClusters: reusedCount,
  };

  const boardData = {
    boardId: fileKey,
    fileKey,
    docStructureHint: input.docStructureHint,
    customPhases: input.customPhases,
    ingestMode,
    cacheKey,
    figmaLastModified,
    nodeHash,
    modelPreset: describeModelConfig().preset,
    qualityReport,
    nodes,
    clusters: finalClusters,
    connectorEdges,
    clusterRelations,
    createdAt: Date.now(),
  };
  setBoard(fileKey, boardData);
  await writeCachedBoard(cacheKey, boardData);
  await writeLatestBoardPointer(fileKey, cacheKey);
  await writeBoardHistoryEntry(fileKey, { cacheKey, nodeHash, createdAt: boardData.createdAt });

  return {
    boardId: fileKey,
    clusterCount: finalClusters.length,
    relationCount: clusterRelations.length,
    qualityReport,
    summary: buildSummary(fileKey, finalClusters, input.docStructureHint, qualityReport),
  };
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

/**
 * Picks the nodes that participate in geometric clustering: leaf content
 * nodes only. Containers (anything that still has children in the flattened
 * list) would double-count their members, and CONNECTOR lines deliberately
 * span between groups — their bounding boxes would merge otherwise separate
 * clusters. Zero-size entries (document/canvas) carry no position signal.
 */
function selectClusterableNodes(nodes: NormalizedNode[]): NormalizedNode[] {
  const parentIds = new Set(nodes.map((node) => node.parentId).filter(Boolean));
  return nodes.filter(
    (node) =>
      !parentIds.has(node.id) &&
      node.type !== "CONNECTOR" &&
      (node.width > 0 || node.height > 0),
  );
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
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(new VisionDeadlineExceededError());
  }

  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const error = new VisionDeadlineExceededError();
      controller.abort(error);
      reject(error);
    }, remainingMs);
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
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
async function buildReuseIndex(fileKey: string): Promise<Map<string, RefinedCluster>> {
  const previous = await readLatestBoard(fileKey);
  if (!previous) {
    return new Map();
  }

  const nodesById = new Map(previous.nodes.map((node) => [node.id, node]));
  const index = new Map<string, RefinedCluster>();
  for (const cluster of previous.clusters) {
    const clusterNodes = cluster.nodeIds
      .map((id) => nodesById.get(id))
      .filter((node): node is NormalizedNode => node !== undefined);
    if (clusterNodes.length === cluster.nodeIds.length && clusterNodes.length > 0) {
      index.set(hashClusterNodes(clusterNodes), cluster);
    }
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
      `It includes ${imageCount} image element${imageCount === 1 ? "" : "s"} that were not visually described because timeout-safe fallback was used.`,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  return {
    modelsUsed,
    cachedClusters,
    deterministicClusters: clusters.filter((cluster) => cluster.summarySource === "deterministic")
      .length,
    visionClusters: clusters.filter((cluster) => cluster.summarySource === "vision_llm").length,
    fallbackCount: 0,
  };
}

function buildSummary(
  fileKey: string,
  clusters: RefinedCluster[],
  docStructureHint: IngestBoardInput["docStructureHint"],
  qualityReport: IngestQualityReport,
): string {
  const labels = clusters.map((cluster) => `"${cluster.label}"`);
  const shownLabels = labels.slice(0, 8).join(", ") + (labels.length > 8 ? ", ..." : "");
  const fallbackNote =
    qualityReport.fallbackCount > 0
      ? ` ${qualityReport.fallbackCount} cluster${qualityReport.fallbackCount === 1 ? "" : "s"} used text fallback because vision processing timed out, failed, or exceeded the MCP-safe budget.`
      : "";
  const cacheNote =
    qualityReport.cachedClusters > 0 ? ` Loaded ${qualityReport.cachedClusters} clusters from cache.` : "";
  const reuseNote =
    (qualityReport.reusedClusters ?? 0) > 0
      ? ` Reused ${qualityReport.reusedClusters} unchanged cluster${qualityReport.reusedClusters === 1 ? "" : "s"} from the previous ingest.`
      : "";
  return (
    `Ingested board ${fileKey}: ${clusters.length} clusters - ${shownLabels} ` +
    `(docStructureHint=${docStructureHint}).${cacheNote}${reuseNote}${fallbackNote}`
  );
}
