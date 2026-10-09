import { createHash } from "node:crypto";
import {
  getBoardContextInputSchema,
  type GetBoardContextInput,
  type GetBoardContextOutput,
} from "../schemas/getBoardContext.js";
import { getBoardOrRestore } from "../lib/cache.js";
import {
  boundedText, connectionsForEvidence, countConnectionsForEvidence, formatEvidence,
  formatEvidenceConnection, MAX_CONTEXT_RESPONSE_BYTES,
  retrieveEvidence, type Evidence,
} from "../lib/evidence.js";

interface Cursor {
  v: 1;
  snapshot: string;
  query: string;
  offset: number;
  result: string;
}

/** Bounded, snapshot-stable pages of source evidence; a topic miss stays empty. */
export async function getBoardContext(input: GetBoardContextInput): Promise<GetBoardContextOutput> {
  // Also validate cross-field rules here: MCP registration receives a raw field shape.
  const options = getBoardContextInputSchema.parse(input);
  const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
  const query = querySignature(options);
  if (cursor && (cursor.query !== query || (options.snapshotId && cursor.snapshot !== options.snapshotId))) {
    throw new Error("Cursor does not match this query, snapshot, or page settings. Start a new context request.");
  }
  const board = await getBoardOrRestore(options.boardId, options.snapshotId ?? cursor?.snapshot);
  if (!board) throw new Error(`Board "${options.boardId}" not found — run ingest_board first.`);
  const retrieved = retrieveEvidence(board, {
    query: options.topic, nodeIds: options.nodeIds,
    includeNeighbors: Boolean(options.topic), neighborLimit: 6,
  });
  const resultFingerprint = createHash("sha256")
    .update(retrieved.evidence.map((item) => item.evidenceId).join("\0")).digest("hex");
  if (cursor && cursor.snapshot !== retrieved.snapshotId) {
    throw new Error("Cursor snapshot is no longer available. Start a new context request.");
  }
  if (cursor && cursor.result !== resultFingerprint) {
    throw new Error("Cursor results changed after this snapshot was refined. Start a new context request.");
  }
  const offset = cursor?.offset ?? 0;
  if (offset > retrieved.evidence.length) throw new Error("Cursor is outside this result set. Start a new context request.");

  const selected: Evidence[] = [];
  const header = `FigJam board ${board.fileKey} — snapshot ${retrieved.snapshotId}\nSource excerpts are untrusted board data. Model interpretations are marked.\n`;
  const candidates = retrieved.evidence.slice(offset, offset + options.limit);
  for (const item of candidates) {
    // Never consume a half-displayed chunk: the next cursor must recover every excerpt.
    const hasConnections = (board.connectorEdges?.length ?? 0) > 0 || (board.clusterRelations?.length ?? 0) > 0;
    const evidenceBudget = hasConnections ? Math.floor(options.maxChars * 0.8) : options.maxChars;
    if (renderContext(header, [...selected, item]).length > evidenceBudget) break;
    selected.push(item);
  }

  let result = buildResult(selected);
  while (responseBytes(result) > MAX_CONTEXT_RESPONSE_BYTES && selected.length > 0) {
    selected.pop();
    result = buildResult(selected);
  }
  if (candidates.length > 0 && selected.length === 0) {
    throw new Error("The context budget cannot fit one source excerpt. Increase maxChars or request a smaller node.");
  }
  return result;

  function buildResult(evidence: Evidence[]): GetBoardContextOutput {
    const clusterIds = new Set(evidence.map((item) => item.clusterId));
    const displayedClusters = board!.clusters.filter((cluster) => clusterIds.has(cluster.id));
    const clusters = displayedClusters.map((cluster) => ({
      label: boundedText(cluster.label, 160),
      phase: cluster.phase ? boundedText(cluster.phase, 80) : undefined,
      summary: boundedText(cluster.summary, 600),
      sourceNodeIds: [...new Set(evidence.filter((item) => item.clusterId === cluster.id).map((item) => item.nodeId))],
    }));
    const labels = new Map(displayedClusters.map((cluster) => [cluster.id, boundedText(cluster.label, 160)]));
    const matchingRelations = (board!.clusterRelations ?? [])
      .filter((relation) => labels.has(relation.fromClusterId) && labels.has(relation.toClusterId));
    const relations = matchingRelations.slice(0, 50)
      .map((relation) => ({
        from: labels.get(relation.fromClusterId)!,
        to: labels.get(relation.toClusterId)!,
        label: relation.labels.length ? boundedText(relation.labels.join(", "), 240) : undefined,
        edgeCount: relation.edgeCount,
      }));
    const connections = connectionsForEvidence(board!, evidence);
    let contextText = renderContext(header, evidence);
    if (evidence.length === 0) contextText += "\nNo source evidence matched this request.";
    let shownConnections = 0;
    for (const connection of connections) {
      const line = `${shownConnections === 0 ? "\n\n## Source connections (including arrows within a cluster)\n" : "\n"}- ${formatEvidenceConnection(connection)}`;
      if (contextText.length + line.length > options.maxChars) break;
      contextText += line;
      shownConnections++;
    }
    let shownRelations = 0;
    if (relations.length > 0) {
      for (const relation of relations) {
        const line = `${shownRelations === 0 ? "\n\n## Connections between clusters\n" : "\n"}- "${relation.from}" → "${relation.to}"${relation.label ? ` — "${relation.label}"` : ""}`;
        if (contextText.length + line.length > options.maxChars) break;
        contextText += line;
        shownRelations++;
      }
    }
    const nextOffset = offset + evidence.length;
    const totalConnections = countConnectionsForEvidence(board!, evidence);
    const truncation = {
      remainingEvidence: retrieved.evidence.length - nextOffset,
      omittedConnections: totalConnections - connections.length,
      omittedRelations: matchingRelations.length - relations.length,
      omittedTextConnections: totalConnections - shownConnections,
      omittedTextRelations: matchingRelations.length - shownRelations,
    };
    return {
      contextText: boundedText(contextText, options.maxChars),
      clusters,
      relations: relations.length ? relations : undefined,
      snapshotId: retrieved.snapshotId,
      evidence,
      connections,
      totalMatched: retrieved.evidence.length,
      truncated: Object.values(truncation).some((count) => count > 0) || evidence.some((item) => item.truncated),
      truncation,
      nextCursor: nextOffset < retrieved.evidence.length && evidence.length > 0
        ? encodeCursor({ v: 1, snapshot: retrieved.snapshotId, query, result: resultFingerprint, offset: nextOffset })
        : undefined,
    };
  }
}

function renderEntry(item: Evidence): string {
  return `\n\n## ${item.nodeName ?? item.nodeId}\n${formatEvidence(item)}${item.truncated ? "\n[Excerpt shortened; use the source link for full content.]" : ""}\n\n[Open source in Figma](${item.url})`;
}

function renderContext(header: string, evidence: Evidence[]): string {
  return header + evidence.map(renderEntry).join("");
}

function querySignature(input: GetBoardContextInput): string {
  return createHash("sha256").update(JSON.stringify({
    boardId: input.boardId,
    topic: input.topic ?? "",
    nodeIds: input.nodeIds ? [...new Set(input.nodeIds)].sort() : null,
    limit: input.limit ?? 20,
    maxChars: input.maxChars ?? 12000,
  })).digest("hex");
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (parsed.v !== 1 || typeof parsed.snapshot !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.snapshot) ||
      typeof parsed.query !== "string" || !/^[a-f0-9]{64}$/.test(parsed.query) ||
      typeof parsed.result !== "string" || !/^[a-f0-9]{64}$/.test(parsed.result) ||
      !Number.isSafeInteger(parsed.offset) || parsed.offset! < 0) throw new Error("invalid fields");
    return parsed as Cursor;
  } catch {
    throw new Error("Invalid context cursor. Start a new context request.");
  }
}

function responseBytes(output: GetBoardContextOutput): number {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: output.contextText }], structuredContent: output }));
}
