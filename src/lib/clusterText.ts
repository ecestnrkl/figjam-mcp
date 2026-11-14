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

/**
 * Names deterministic clusters (no model label) on every ingest, including reused
 * and cached ones. A cluster with at least two text nodes in one named innermost
 * section is named after it: the section name if it is the section's only cluster,
 * else "<section>: <first text>". Other clusters take their first text or name.
 */
export function labelDeterministicClusters(clusters: RefinedCluster[], clusterNodes: NormalizedNode[][],
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
