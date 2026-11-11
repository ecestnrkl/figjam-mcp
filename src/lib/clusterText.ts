import type { Cluster, NormalizedNode, RefinedCluster } from "../types.js";
import { isGenericNodeName } from "./nodeTree.js";

export function refineClusterFromText(cluster: Cluster, clusterNodes: NormalizedNode[]): RefinedCluster {
  const imageCount = clusterNodes.filter((node) => node.imageRef).length;

  return {
    ...cluster,
    label: fallbackLabel(cluster.id, clusterNodes),
    summary: fallbackSummary(clusterNodes.length, textSnippets(clusterNodes), imageCount),
    confirmedNodeIds: [...cluster.nodeIds],
    summarySource: "deterministic",
  };
}

/** Top to bottom, then left to right; member order breaks ties. */
export function inReadingOrder(nodes: NormalizedNode[]): NormalizedNode[] {
  return nodes.map((node, position) => ({ node, position }))
    .sort((a, b) => a.node.y - b.node.y || a.node.x - b.node.x || a.position - b.position)
    .map(({ node }) => node);
}

export function textSnippets(nodes: NormalizedNode[]): string[] {
  return nodes.map((node) => node.text?.trim()).filter((text): text is string => Boolean(text));
}

/** The first text in reading order, else the first specific node name. */
export function fallbackLabel(clusterId: string, clusterNodes: NormalizedNode[]): string {
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

export function fallbackSummary(
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
      `It includes ${imageCount} image element${imageCount === 1 ? "" : "s"} that ${imageCount === 1 ? "has" : "have"} not been visually interpreted in this summary.`,
    );
  }

  parts.push("The source node IDs are retained for follow-up context.");
  return parts.join(" ");
}

export function compactLabel(text: string): string {
  const normalized = text.replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
  const words = normalized.split(" ").filter(Boolean).slice(0, 6).join(" ");
  return truncate(words || normalized, 60);
}

export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
