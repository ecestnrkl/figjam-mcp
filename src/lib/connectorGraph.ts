import type { Cluster, ClusterRelation, ConnectorEdge, NormalizedNode, RefinedCluster } from "../types.js";

/**
 * Connector arrows are excluded from geometric clustering (they deliberately
 * span between groups), but they carry the board's semantic structure:
 * "A leads to B". This module extracts them as a graph and aggregates them
 * to cluster-level relations that get_board_context / answer_from_board can
 * hand to the LLM as relationship context.
 */

/**
 * Pulls all fully attached connector arrows out of the flattened node list.
 * Connectors dangling in empty space (missing either endpoint) are skipped —
 * without both endpoints there is no relation to express.
 */
export function extractConnectorEdges(nodes: NormalizedNode[]): ConnectorEdge[] {
  return nodes
    .filter(
      (node) =>
        node.type === "CONNECTOR" && Boolean(node.connectorStartId) && Boolean(node.connectorEndId),
    )
    .map((node) => ({
      connectorId: node.id,
      fromNodeId: node.connectorStartId!,
      toNodeId: node.connectorEndId!,
      label: node.text?.trim() || undefined,
    }));
}

/**
 * Aggregates node-level connector edges into directed cluster-to-cluster
 * relations. Edges within one cluster are dropped (the cluster summary
 * already covers internal structure); parallel edges between the same
 * cluster pair are merged, collecting their unique labels. Sorted by
 * edgeCount so the strongest relations come first.
 */
export function buildClusterRelations(
  edges: ConnectorEdge[],
  clusters: Cluster[],
): ClusterRelation[] {
  const clusterOfNode = new Map<string, string>();
  for (const cluster of clusters) {
    for (const nodeId of cluster.nodeIds) {
      clusterOfNode.set(nodeId, cluster.id);
    }
  }

  const relations = new Map<string, ClusterRelation>();
  for (const edge of edges) {
    const from = clusterOfNode.get(edge.fromNodeId);
    const to = clusterOfNode.get(edge.toNodeId);
    if (!from || !to || from === to) {
      continue;
    }

    const key = `${from}->${to}`;
    const relation = relations.get(key) ?? {
      fromClusterId: from,
      toClusterId: to,
      labels: [],
      edgeCount: 0,
    };
    relation.edgeCount++;
    if (edge.label && !relation.labels.includes(edge.label)) {
      relation.labels.push(edge.label);
    }
    relations.set(key, relation);
  }

  return [...relations.values()].sort((a, b) => b.edgeCount - a.edgeCount);
}

/**
 * Renders cluster relations as compact human/LLM-readable lines, e.g.
 * `"User interviews" → "Problem framing" — "informs" (2 connectors)`.
 * Relations pointing at clusters missing from `clusters` (e.g. filtered out
 * by a topic) are skipped.
 */
export function formatClusterRelations(
  relations: ClusterRelation[],
  clusters: RefinedCluster[],
): string[] {
  const labelOf = new Map(clusters.map((cluster) => [cluster.id, cluster.label]));

  return relations
    .filter((rel) => labelOf.has(rel.fromClusterId) && labelOf.has(rel.toClusterId))
    .map((rel) => {
      const labels = rel.labels.length > 0 ? ` — "${rel.labels.join('", "')}"` : "";
      const count = rel.edgeCount > 1 ? ` (${rel.edgeCount} connectors)` : "";
      return `- "${labelOf.get(rel.fromClusterId)}" → "${labelOf.get(rel.toClusterId)}"${labels}${count}`;
    });
}
