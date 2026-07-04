import type { IngestBoardInput, IngestBoardOutput } from "../schemas/ingestBoard.js";
import type { Cluster, NormalizedNode, RefinedCluster } from "../types.js";
import { fetchFileTree, fetchScreenshot } from "../lib/figmaApi.js";
import { flattenNodeTree } from "../lib/nodeTree.js";
import { geometricPreCluster } from "../lib/spatialCluster.js";
import { refineClusterWithVision } from "../lib/visionInterpreter.js";
import { mapToDoubleDiamond } from "../lib/docStructureMapper.js";
import { setBoard } from "../lib/cache.js";
import { readIntEnv } from "../lib/env.js";

/**
 * Max node screenshots sent to the vision model per cluster. Nodes with
 * image fills are prioritized (their content is invisible in extracted
 * text), then the largest remaining nodes. Text of ALL nodes still reaches
 * the model via the prompt, so capping only limits redundant pixels.
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
 * ingest_board — full pipeline: fetch the Figma file, flatten + filter the
 * node tree, pre-cluster geometrically, refine each cluster with vision
 * (screenshots + text in one request), optionally map clusters onto Double
 * Diamond phases, and cache the result.
 *
 * The boardId is the Figma fileKey itself: one cache entry per file, and a
 * repeated ingest_board call simply refreshes it.
 */
export async function ingestBoard(input: IngestBoardInput): Promise<IngestBoardOutput> {
  const startedAt = Date.now();
  const fileKey = parseFigmaFileKey(input.figmaFileUrl);
  const token = input.figmaAccessToken ?? process.env.FIGMA_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "No Figma access token — pass figmaAccessToken or set FIGMA_ACCESS_TOKEN in .env",
    );
  }

  const rawTree = await fetchFileTree(fileKey, token);
  const nodes = flattenNodeTree(rawTree);
  const clusters = geometricPreCluster(selectClusterableNodes(nodes));

  if (clusters.length === 0) {
    throw new Error(`Board ${fileKey} contains no content nodes to ingest`);
  }

  // Refine clusters one at a time while the MCP-safe vision budget allows it;
  // remaining clusters still get deterministic text summaries and are cached.
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const refined: RefinedCluster[] = [];
  let textFallbackCount = 0;
  for (const cluster of clusters) {
    const clusterNodes = cluster.nodeIds
      .map((id) => nodesById.get(id))
      .filter((node): node is NormalizedNode => node !== undefined);

    if (!hasVisionBudget(startedAt)) {
      refined.push(refineClusterFromText(cluster, clusterNodes));
      textFallbackCount++;
      continue;
    }

    try {
      const screenshots = await fetchScreenshot(
        fileKey,
        pickScreenshotNodes(clusterNodes),
        token,
      );
      refined.push(await refineClusterWithVision(cluster, screenshots, clusterNodes));
    } catch (error) {
      console.error(
        `Vision refinement failed for ${cluster.id}; using text fallback: ${errorMessage(error)}`,
      );
      refined.push(refineClusterFromText(cluster, clusterNodes));
      textFallbackCount++;
    }
  }

  const finalClusters =
    input.docStructureHint === "double_diamond" ? mapToDoubleDiamond(refined) : refined;

  setBoard(fileKey, {
    boardId: fileKey,
    fileKey,
    docStructureHint: input.docStructureHint,
    nodes,
    clusters: finalClusters,
    createdAt: Date.now(),
  });

  const labels = finalClusters.map((c) => `"${c.label}"`);
  const shownLabels = labels.slice(0, 8).join(", ") + (labels.length > 8 ? ", …" : "");
  const fallbackNote =
    textFallbackCount > 0
      ? ` ${textFallbackCount} cluster${textFallbackCount === 1 ? "" : "s"} used text fallback because vision processing timed out, failed, or exceeded the MCP-safe budget.`
      : "";
  return {
    boardId: fileKey,
    clusterCount: finalClusters.length,
    summary:
      `Ingested board ${fileKey}: ${finalClusters.length} clusters — ${shownLabels} ` +
      `(docStructureHint=${input.docStructureHint}).${fallbackNote}`,
  };
}

/**
 * Extracts the file key from a Figma/FigJam URL, e.g.
 * https://www.figma.com/board/AbC123xyz/My-Board?node-id=…  →  AbC123xyz
 */
export function parseFigmaFileKey(url: string): string {
  const match = /figma\.com\/(?:file|design|board|proto)\/([A-Za-z0-9]+)/.exec(url);
  if (!match?.[1]) {
    throw new Error(
      `Invalid Figma URL "${url}" — expected https://www.figma.com/(file|design|board)/<file_key>/… (check the Figma file URL)`,
    );
  }
  return match[1];
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
    return imageDiff !== 0 ? imageDiff : b.width * b.height - a.width * a.height;
  });
  return ranked.slice(0, MAX_SCREENSHOTS_PER_CLUSTER).map((node) => node.id);
}

function hasVisionBudget(startedAt: number): boolean {
  return VISION_BUDGET_MS > 0 && Date.now() - startedAt + MIN_VISION_SLOT_MS <= VISION_BUDGET_MS;
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
