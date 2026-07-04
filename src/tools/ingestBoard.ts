import type { IngestBoardInput, IngestBoardOutput } from "../schemas/ingestBoard.js";
import type { NormalizedNode, RefinedCluster } from "../types.js";
import { fetchFileTree, fetchScreenshot } from "../lib/figmaApi.js";
import { flattenNodeTree } from "../lib/nodeTree.js";
import { geometricPreCluster } from "../lib/spatialCluster.js";
import { refineClusterWithVision } from "../lib/visionInterpreter.js";
import { mapToDoubleDiamond } from "../lib/docStructureMapper.js";
import { setBoard } from "../lib/cache.js";

/**
 * Max node screenshots sent to the vision model per cluster. Nodes with
 * image fills are prioritized (their content is invisible in extracted
 * text), then the largest remaining nodes. Text of ALL nodes still reaches
 * the model via the prompt, so capping only limits redundant pixels.
 */
const MAX_SCREENSHOTS_PER_CLUSTER = 6;

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

  // Refine clusters strictly one at a time: each iteration is one Figma
  // render call + one vision call, which stays well inside free-tier LLM
  // rate limits (~20 req/min) even for large boards.
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const refined: RefinedCluster[] = [];
  for (const cluster of clusters) {
    const clusterNodes = cluster.nodeIds
      .map((id) => nodesById.get(id))
      .filter((node): node is NormalizedNode => node !== undefined);

    const screenshots = await fetchScreenshot(
      fileKey,
      pickScreenshotNodes(clusterNodes),
      token,
    );
    refined.push(await refineClusterWithVision(cluster, screenshots, clusterNodes));
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
  return {
    boardId: fileKey,
    clusterCount: finalClusters.length,
    summary:
      `Ingested board ${fileKey}: ${finalClusters.length} clusters — ${shownLabels} ` +
      `(docStructureHint=${input.docStructureHint}).`,
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
