import type { BoardData, ConnectorEdge, NormalizedNode, RefinedCluster } from "../types.js";
import { STRUCTURAL_TYPES } from "./nodeTree.js";
import { hashClusterNodes } from "./persistentCache.js";

/**
 * Compares two ingest snapshots of the same board — "what changed since the
 * last workshop?". Works on three levels:
 *  - nodes: added / removed / edited content nodes (structural containers
 *    and connectors excluded — connectors are diffed separately),
 *  - clusters: matched across snapshots by member overlap, then classified
 *    as unchanged (same content hash), modified, new, or removed,
 *  - connections: connector arrows diffed as (from, to, label) edges and
 *    rendered with the owning clusters' labels.
 */

export interface ClusterSummaryRef {
  label: string;
  summary: string;
}

export interface ModifiedClusterDiff {
  label: string;
  previousLabel: string;
  addedNodeCount: number;
  removedNodeCount: number;
  editedNodeCount: number;
}

export interface BoardDiffStats {
  addedNodes: number;
  removedNodes: number;
  editedNodes: number;
  newClusters: number;
  removedClusters: number;
  modifiedClusters: number;
  unchangedClusters: number;
  addedConnections: number;
  removedConnections: number;
}

export interface BoardDiffResult {
  stats: BoardDiffStats;
  newClusters: ClusterSummaryRef[];
  removedClusters: ClusterSummaryRef[];
  modifiedClusters: ModifiedClusterDiff[];
  addedConnections: string[];
  removedConnections: string[];
  summaryText: string;
}

/** Minimum member overlap (relative to the smaller cluster) to treat two clusters as the same. */
const CLUSTER_MATCH_THRESHOLD = 0.5;

/** Max entries rendered per section in summaryText. */
const SUMMARY_SECTION_LIMIT = 8;

export function diffBoards(baseline: BoardData, current: BoardData): BoardDiffResult {
  const baselineNodes = contentNodesById(baseline);
  const currentNodes = contentNodesById(current);

  const addedNodeIds = [...currentNodes.keys()].filter((id) => !baselineNodes.has(id));
  const removedNodeIds = [...baselineNodes.keys()].filter((id) => !currentNodes.has(id));
  const editedNodeIds = [...currentNodes.keys()].filter((id) => {
    const before = baselineNodes.get(id);
    return before !== undefined && nodeContentChanged(before, currentNodes.get(id)!);
  });

  const clusterDiff = diffClusters(baseline, current);
  const connectionDiff = diffConnections(baseline, current);

  const stats: BoardDiffStats = {
    addedNodes: addedNodeIds.length,
    removedNodes: removedNodeIds.length,
    editedNodes: editedNodeIds.length,
    newClusters: clusterDiff.newClusters.length,
    removedClusters: clusterDiff.removedClusters.length,
    modifiedClusters: clusterDiff.modifiedClusters.length,
    unchangedClusters: clusterDiff.unchangedClusters,
    addedConnections: connectionDiff.added.length,
    removedConnections: connectionDiff.removed.length,
  };

  return {
    stats,
    newClusters: clusterDiff.newClusters,
    removedClusters: clusterDiff.removedClusters,
    modifiedClusters: clusterDiff.modifiedClusters,
    addedConnections: connectionDiff.added,
    removedConnections: connectionDiff.removed,
    summaryText: buildSummaryText(baseline, current, stats, clusterDiff, connectionDiff),
  };
}

/** Leaf content nodes: everything except structural containers and connectors. */
function contentNodesById(board: BoardData): Map<string, NormalizedNode> {
  const map = new Map<string, NormalizedNode>();
  for (const node of board.nodes) {
    if (!STRUCTURAL_TYPES.has(node.type) && node.type !== "CONNECTOR") {
      map.set(node.id, node);
    }
  }
  return map;
}

function nodeContentChanged(before: NormalizedNode, after: NormalizedNode): boolean {
  return (before.text?.trim() ?? "") !== (after.text?.trim() ?? "") ||
    before.imageRef !== after.imageRef;
}

interface ClusterDiffInternal {
  newClusters: ClusterSummaryRef[];
  removedClusters: ClusterSummaryRef[];
  modifiedClusters: ModifiedClusterDiff[];
  unchangedClusters: number;
}

/**
 * Greedy best-overlap matching: cluster pairs are ranked by shared member
 * count and matched one-to-one while the overlap covers at least half of
 * the smaller cluster. Matched pairs with identical content hashes count as
 * unchanged; everything unmatched is new (current side) or removed
 * (baseline side).
 */
function diffClusters(baseline: BoardData, current: BoardData): ClusterDiffInternal {
  const baselineNodesById = new Map(baseline.nodes.map((node) => [node.id, node]));
  const currentNodesById = new Map(current.nodes.map((node) => [node.id, node]));

  const pairs: Array<{ prev: RefinedCluster; cur: RefinedCluster; overlap: number }> = [];
  for (const prev of baseline.clusters) {
    const prevIds = new Set(prev.nodeIds);
    for (const cur of current.clusters) {
      const overlap = cur.nodeIds.filter((id) => prevIds.has(id)).length;
      if (overlap > 0 && overlap / Math.min(prevIds.size, cur.nodeIds.length) >= CLUSTER_MATCH_THRESHOLD) {
        pairs.push({ prev, cur, overlap });
      }
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap);

  const matchedPrev = new Set<string>();
  const matchedCur = new Set<string>();
  const modifiedClusters: ModifiedClusterDiff[] = [];
  let unchangedClusters = 0;

  for (const { prev, cur } of pairs) {
    if (matchedPrev.has(prev.id) || matchedCur.has(cur.id)) {
      continue;
    }
    matchedPrev.add(prev.id);
    matchedCur.add(cur.id);

    const prevMembers = membersOf(prev, baselineNodesById);
    const curMembers = membersOf(cur, currentNodesById);
    if (hashClusterNodes(prevMembers) === hashClusterNodes(curMembers)) {
      unchangedClusters++;
      continue;
    }

    const prevIds = new Set(prev.nodeIds);
    const curIds = new Set(cur.nodeIds);
    const sharedIds = cur.nodeIds.filter((id) => prevIds.has(id));
    modifiedClusters.push({
      label: cur.label,
      previousLabel: prev.label,
      addedNodeCount: cur.nodeIds.filter((id) => !prevIds.has(id)).length,
      removedNodeCount: prev.nodeIds.filter((id) => !curIds.has(id)).length,
      editedNodeCount: sharedIds.filter((id) => {
        const before = baselineNodesById.get(id);
        const after = currentNodesById.get(id);
        return before !== undefined && after !== undefined && nodeContentChanged(before, after);
      }).length,
    });
  }

  return {
    newClusters: current.clusters
      .filter((cluster) => !matchedCur.has(cluster.id))
      .map((cluster) => ({ label: cluster.label, summary: cluster.summary })),
    removedClusters: baseline.clusters
      .filter((cluster) => !matchedPrev.has(cluster.id))
      .map((cluster) => ({ label: cluster.label, summary: cluster.summary })),
    modifiedClusters,
    unchangedClusters,
  };
}

function membersOf(
  cluster: RefinedCluster,
  nodesById: Map<string, NormalizedNode>,
): NormalizedNode[] {
  return cluster.nodeIds
    .map((id) => nodesById.get(id))
    .filter((node): node is NormalizedNode => node !== undefined);
}

interface ConnectionDiffInternal {
  added: string[];
  removed: string[];
}

/**
 * Diffs connector edges as a multiset of (from, to, label) tuples.
 *
 * Connector IDs are deliberately ignored: replacing an arrow without changing
 * its meaning is not a semantic board change. Multiplicity still matters,
 * though — removing one of two parallel arrows must be reported.
 */
function diffConnections(baseline: BoardData, current: BoardData): ConnectionDiffInternal {
  const baselineEdges = groupEdgesByMeaning(baseline.connectorEdges ?? []);
  const currentEdges = groupEdgesByMeaning(current.connectorEdges ?? []);
  const keys = new Set([...baselineEdges.keys(), ...currentEdges.keys()]);
  const added: string[] = [];
  const removed: string[] = [];

  for (const key of keys) {
    const before = baselineEdges.get(key) ?? [];
    const after = currentEdges.get(key) ?? [];

    for (let index = before.length; index < after.length; index++) {
      added.push(formatEdge(after[index]!, current));
    }
    for (let index = after.length; index < before.length; index++) {
      removed.push(formatEdge(before[index]!, baseline));
    }
  }

  return { added, removed };
}

function groupEdgesByMeaning(edges: ConnectorEdge[]): Map<string, ConnectorEdge[]> {
  const grouped = new Map<string, ConnectorEdge[]>();
  for (const edge of edges) {
    const key = JSON.stringify([edge.fromNodeId, edge.toNodeId, edge.label ?? ""]);
    const matches = grouped.get(key) ?? [];
    matches.push(edge);
    grouped.set(key, matches);
  }
  return grouped;
}

/** Renders one edge with the owning clusters' labels (from its own snapshot). */
function formatEdge(edge: ConnectorEdge, board: BoardData): string {
  const from = endpointLabel(edge.fromNodeId, board);
  const to = endpointLabel(edge.toNodeId, board);
  return `"${from}" → "${to}"${edge.label ? ` — "${edge.label}"` : ""}`;
}

function endpointLabel(nodeId: string, board: BoardData): string {
  const cluster = board.clusters.find((c) => c.nodeIds.includes(nodeId));
  if (cluster) {
    return cluster.label;
  }
  const node = board.nodes.find((n) => n.id === nodeId);
  const text = node?.text?.trim();
  return text ? truncate(text, 40) : node?.name ?? nodeId;
}

function buildSummaryText(
  baseline: BoardData,
  current: BoardData,
  stats: BoardDiffStats,
  clusters: ClusterDiffInternal,
  connections: ConnectionDiffInternal,
): string {
  const lines: string[] = [
    `FigJam board ${current.fileKey} — changes from ${timestamp(baseline.createdAt)} to ${timestamp(current.createdAt)}:`,
    "",
  ];

  if (
    stats.addedNodes + stats.removedNodes + stats.editedNodes === 0 &&
    stats.newClusters + stats.removedClusters + stats.modifiedClusters === 0 &&
    stats.addedConnections + stats.removedConnections === 0
  ) {
    lines.push("No changes — the board content is identical.");
    return lines.join("\n");
  }

  if (clusters.newClusters.length > 0) {
    lines.push(`New clusters (${clusters.newClusters.length}):`);
    lines.push(
      ...capped(clusters.newClusters, (c) => `- "${c.label}": ${firstSentence(c.summary)}`),
    );
  }
  if (clusters.removedClusters.length > 0) {
    lines.push(`Removed clusters (${clusters.removedClusters.length}):`);
    lines.push(...capped(clusters.removedClusters, (c) => `- "${c.label}"`));
  }
  if (clusters.modifiedClusters.length > 0) {
    lines.push(`Modified clusters (${clusters.modifiedClusters.length}):`);
    lines.push(
      ...capped(clusters.modifiedClusters, (c) => {
        const renamed = c.previousLabel !== c.label ? ` (was "${c.previousLabel}")` : "";
        const parts = [
          c.addedNodeCount > 0 ? `+${c.addedNodeCount} nodes` : "",
          c.removedNodeCount > 0 ? `-${c.removedNodeCount} nodes` : "",
          c.editedNodeCount > 0 ? `${c.editedNodeCount} edited` : "",
        ].filter(Boolean);
        return `- "${c.label}"${renamed}: ${parts.join(", ") || "reorganized"}`;
      }),
    );
  }
  if (connections.added.length > 0 || connections.removed.length > 0) {
    lines.push(`Connections: +${connections.added.length} / -${connections.removed.length}`);
    lines.push(...capped(connections.added, (line) => `- new: ${line}`));
    lines.push(...capped(connections.removed, (line) => `- removed: ${line}`));
  }
  lines.push(
    `Nodes: +${stats.addedNodes} added / -${stats.removedNodes} removed / ${stats.editedNodes} edited.`,
  );
  if (stats.unchangedClusters > 0) {
    lines.push(`Unchanged clusters: ${stats.unchangedClusters}.`);
  }

  return lines.join("\n");
}

function capped<T>(items: T[], render: (item: T) => string): string[] {
  const lines = items.slice(0, SUMMARY_SECTION_LIMIT).map(render);
  if (items.length > SUMMARY_SECTION_LIMIT) {
    lines.push(`- … and ${items.length - SUMMARY_SECTION_LIMIT} more`);
  }
  return lines;
}

function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function firstSentence(text: string): string {
  return text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
