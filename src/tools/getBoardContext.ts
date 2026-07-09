import type {
  GetBoardContextInput,
  GetBoardContextOutput,
} from "../schemas/getBoardContext.js";
import type { ClusterRelation, RefinedCluster } from "../types.js";
import { getBoardOrRestore } from "../lib/cache.js";
import { formatClusterRelations } from "../lib/connectorGraph.js";

/**
 * get_board_context — reads an ingested board from the cache (restoring the
 * last persisted ingest after a server restart) and formats a token-lean
 * context block that can be pasted directly into a chat session: one clear
 * paragraph per cluster (label, phase, summary) plus the connector-derived
 * relations between clusters, no raw node data. An optional topic narrows
 * the output to matching clusters.
 */
export async function getBoardContext(
  input: GetBoardContextInput,
): Promise<GetBoardContextOutput> {
  const board = await getBoardOrRestore(input.boardId);
  if (!board) {
    throw new Error(
      `Board "${input.boardId}" not found in memory or on-disk cache — run ingest_board first (the boardId is the Figma file key).`,
    );
  }

  const matching = input.topic ? filterByTopic(board.clusters, input.topic) : board.clusters;

  // If a topic matches nothing, degrade gracefully to the full board rather
  // than returning an empty (useless) context.
  const selected = matching.length > 0 ? matching : board.clusters;
  const note =
    input.topic && matching.length === 0
      ? `(No cluster specifically matched topic "${input.topic}" — showing the full board.)\n\n`
      : "";

  const header = `FigJam board ${board.fileKey} — ${selected.length} of ${board.clusters.length} clusters${input.topic && matching.length > 0 ? ` (topic: ${input.topic})` : ""}:`;
  const paragraphs = selected.map(formatCluster);

  // Only relations whose both ends survived the topic filter are shown —
  // formatClusterRelations drops the rest.
  const selectedRelations = board.clusterRelations ?? [];
  const relationLines = formatClusterRelations(selectedRelations, selected);
  const relationsBlock =
    relationLines.length > 0
      ? `\n\n## Connections between clusters (from connector arrows)\n${relationLines.join("\n")}`
      : "";

  return {
    contextText: `${note}${header}\n\n${paragraphs.join("\n\n")}${relationsBlock}`,
    clusters: selected.map((cluster) => ({
      label: cluster.label,
      phase: cluster.phase,
      summary: cluster.summary,
      // External contract field is sourceNodeIds; internally these are the
      // vision-confirmed member ids.
      sourceNodeIds: cluster.confirmedNodeIds,
    })),
    relations: toRelationContexts(selectedRelations, selected),
  };
}

/** Maps internal cluster ids to labels for the structured relations output. */
function toRelationContexts(
  relations: ClusterRelation[],
  clusters: RefinedCluster[],
): GetBoardContextOutput["relations"] {
  const labelOf = new Map(clusters.map((cluster) => [cluster.id, cluster.label]));
  const mapped = relations
    .filter((rel) => labelOf.has(rel.fromClusterId) && labelOf.has(rel.toClusterId))
    .map((rel) => ({
      from: labelOf.get(rel.fromClusterId)!,
      to: labelOf.get(rel.toClusterId)!,
      label: rel.labels.length > 0 ? rel.labels.join(", ") : undefined,
      edgeCount: rel.edgeCount,
    }));
  return mapped.length > 0 ? mapped : undefined;
}

/** One compact paragraph per cluster: "## Label [phase]" + summary. */
function formatCluster(cluster: RefinedCluster): string {
  const phase = cluster.phase ? ` [${cluster.phase}]` : "";
  return `## ${cluster.label}${phase}\n${cluster.summary}`;
}

/** Case-insensitive word match of the topic against label/summary/phase. */
function filterByTopic(clusters: RefinedCluster[], topic: string): RefinedCluster[] {
  const words = topic
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 2);
  if (words.length === 0) {
    return clusters;
  }

  return clusters.filter((cluster) => {
    const haystack = `${cluster.label} ${cluster.summary} ${cluster.phase ?? ""}`.toLowerCase();
    return words.some((word) => haystack.includes(word));
  });
}
