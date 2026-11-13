import type { BoardData } from "../types.js";
import { buildClusterRelations } from "./connectorGraph.js";

/** Remove artifacts written by older ingests that treated hidden sections as content. */
export function withoutHiddenSectionArtifacts(board: BoardData): BoardData {
  const sections = board.nodes.filter((node) => node.hiddenDescendantIds !== undefined);
  if (!sections.length) return board;
  const sectionIds = new Set(sections.map((node) => node.id));
  const hiddenIds = new Set(sections.flatMap((node) => node.hiddenDescendantIds!));
  const clusters = board.clusters.filter((cluster) => !cluster.nodeIds.some((id) => sectionIds.has(id)));
  const edges = board.connectorEdges?.filter((edge) => !hiddenIds.has(edge.fromNodeId) && !hiddenIds.has(edge.toNodeId));
  if (clusters.length === board.clusters.length && edges?.length === board.connectorEdges?.length) return board;
  const kept = new Set(clusters.map((cluster) => cluster.id));
  return { ...board, clusters, connectorEdges: edges,
    clusterRelations: edges ? buildClusterRelations(edges, clusters)
      : board.clusterRelations?.filter((relation) => kept.has(relation.fromClusterId) && kept.has(relation.toClusterId)) };
}
