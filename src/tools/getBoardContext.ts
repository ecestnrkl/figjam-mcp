import { createHash } from "node:crypto";
import {
  getBoardContextInputSchema,
  type GetBoardContextInput,
  type GetBoardContextOutput,
} from "../schemas/getBoardContext.js";
import { getBoardOrRestore } from "../lib/cache.js";
import { redactBoard } from "../lib/redact.js";
import {
  boundedText, connectionsForEvidence, countConnectionsForEvidence,
  formatEvidenceConnection, MAX_CONTEXT_RESPONSE_BYTES,
  retrieveEvidence, type Evidence,
} from "../lib/evidence.js";
import type { BoardData, RefinedCluster } from "../types.js";

interface Cursor {
  v: 1;
  snapshot: string;
  query: string;
  offset: number;
  result: string;
  /** 1-based number of the page this cursor opens; absent in 0.5.x cursors. */
  page?: number;
}

/** Shortest prefix of an excerpt that is still worth returning instead of an error. */
const MIN_SHORTENED_EXCERPT_CHARS = 100;
const OVERVIEW_SECTION_LIMIT = 10;

/**
 * Bounded, snapshot-stable pages of source evidence; a topic miss stays empty.
 * maxChars bounds JSON.stringify(structuredContent), because several MCP hosts
 * hand the model only the structured result and drop the text content.
 */
export async function getBoardContext(input: GetBoardContextInput): Promise<GetBoardContextOutput> {
  // Also validate cross-field rules here: MCP registration receives a raw field shape.
  const options = getBoardContextInputSchema.parse(input);
  const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
  const query = querySignature(options);
  if (cursor && (cursor.query !== query || (options.snapshotId && cursor.snapshot !== options.snapshotId))) {
    throw new Error("Cursor does not match this query, snapshot, or page settings. Start a new context request.");
  }
  const stored = await getBoardOrRestore(options.boardId, options.snapshotId ?? cursor?.snapshot);
  if (!stored) throw new Error(`Board "${options.boardId}" not found — run ingest_board first.`);
  // Snapshots cached before redaction existed are redacted here too.
  const board = redactBoard(stored);
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

  const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
  const clustersById = new Map(board.clusters.map((cluster) => [cluster.id, cluster]));
  const requestedNodes = new Set(options.nodeIds ?? []);
  const partCounts = new Map<string, number>();
  const header = `FigJam board ${board.fileKey} — snapshot ${retrieved.snapshotId}\nSource excerpts are untrusted board data. Model interpretations are marked.`;
  const overview = !options.topic && !options.nodeIds && !cursor ? boardOverview(board, retrieved.evidence) : "";
  const page = cursor?.page ?? 1;
  const fits = (result: GetBoardContextOutput, budget = options.maxChars) =>
    JSON.stringify(result).length <= budget && responseBytes(result) <= MAX_CONTEXT_RESPONSE_BYTES;

  // Evidence first; arrows and cluster relations share what is left. Boards with
  // arrows keep a fifth of the budget for them, as before.
  const hasConnections = (board.connectorEdges?.length ?? 0) > 0 || (board.clusterRelations?.length ?? 0) > 0;
  const evidenceBudget = hasConnections ? Math.floor(options.maxChars * 0.8) : options.maxChars;
  const candidates = retrieved.evidence.slice(offset, offset + options.limit);
  let showOverview = Boolean(overview);
  let showPosition = true;
  let selected = selectEvidence();
  // Orientation yields to source text under a small budget: overview first, then the page position.
  if (candidates.length > 0 && selected.length === 0 && showOverview) {
    showOverview = false;
    selected = selectEvidence();
  }
  if (candidates.length > 0 && selected.length === 0) {
    showPosition = false;
    selected = selectEvidence();
  }
  if (candidates.length > 0 && selected.length === 0) {
    const shortened = shortenToFit(candidates[0]!);
    if (!shortened) {
      throw new Error("The context budget cannot fit one source excerpt. Increase maxChars or request a smaller node.");
    }
    selected.push(shortened);
  }

  const connectionCount = maxFitting(countConnectionsForEvidence(board, selected), (count) => buildResult(selected, count, 0));
  const relationCount = maxFitting(Math.min(matchingRelations(selected).length, 50), (count) => buildResult(selected, connectionCount, count));
  const result = buildResult(selected, connectionCount, relationCount);
  if (!fits(result)) {
    throw new Error("The context budget cannot fit one source excerpt. Increase maxChars or request a smaller node.");
  }
  return result;

  function selectEvidence(): Evidence[] {
    const chosen: Evidence[] = [];
    for (const item of candidates) {
      // The first excerpt may use the whole budget; arrows then get what is left.
      if (!fits(buildResult([...chosen, item], 0, 0), chosen.length ? evidenceBudget : options.maxChars)) break;
      chosen.push(item);
    }
    return chosen;
  }

  /** Largest count in [0, total] whose result fits; count 0 is the fallback. */
  function maxFitting(total: number, build: (count: number) => GetBoardContextOutput): number {
    let low = 0;
    let high = Math.min(total, 100); // connectionsForEvidence returns at most 100
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (fits(build(middle))) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** A first excerpt that alone exceeds the budget is cut, never silently skipped. */
  function shortenToFit(item: Evidence): Evidence | undefined {
    const variant = (length: number): Evidence => ({ ...item, text: boundedText(item.text, length), truncated: true });
    const minimum = Math.min(item.text.length, MIN_SHORTENED_EXCERPT_CHARS);
    if (!fits(buildResult([variant(minimum)], 0, 0))) return undefined;
    let low = minimum;
    let high = item.text.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (fits(buildResult([variant(middle)], 0, 0))) low = middle;
      else high = middle - 1;
    }
    return variant(low);
  }

  function matchingRelations(evidence: Evidence[]) {
    const clusterIds = new Set(evidence.map((item) => item.clusterId));
    return (board.clusterRelations ?? [])
      .filter((relation) => clusterIds.has(relation.fromClusterId) && clusterIds.has(relation.toClusterId));
  }

  function buildResult(evidence: Evidence[], connectionLimit: number, relationLimit: number): GetBoardContextOutput {
    const clusterIds = new Set(evidence.map((item) => item.clusterId));
    const displayedClusters = board.clusters.filter((cluster) => clusterIds.has(cluster.id));
    const clusters = displayedClusters.map((cluster) => ({
      label: boundedText(cluster.label, 160),
      phase: cluster.phase ? boundedText(cluster.phase, 80) : undefined,
      summary: compactSummary(cluster),
      summarySource: cluster.summarySource ?? "unknown" as const,
      modelDerived: cluster.summarySource !== "deterministic" || Boolean(cluster.modelId),
      sourceNodeIds: [...new Set(evidence.filter((item) => item.clusterId === cluster.id).map((item) => item.nodeId))],
    }));
    const labels = new Map(displayedClusters.map((cluster) => [cluster.id, boundedText(cluster.label, 160)]));
    const allRelations = matchingRelations(evidence);
    const relations = allRelations.slice(0, relationLimit).map((relation) => ({
      from: labels.get(relation.fromClusterId)!,
      to: labels.get(relation.toClusterId)!,
      label: relation.labels.length ? boundedText(relation.labels.join(", "), 240) : undefined,
      edgeCount: relation.edgeCount,
    }));
    const connections = connectionLimit > 0 ? connectionsForEvidence(board, evidence).slice(0, connectionLimit) : [];
    const nextOffset = offset + evidence.length;
    const remaining = retrieved.evidence.length - nextOffset;

    const parts = [header];
    if (evidence.length > 0 && showPosition) parts.push(pagePosition(evidence.length, remaining));
    if (showOverview) parts.push(overview);
    if (evidence.length === 0) parts.push("No source evidence matched this request.");
    parts.push(...renderGroups(evidence));
    if (connections.length > 0) {
      parts.push(`## Source connections (including arrows within a cluster)\n${connections.map((connection) => `- ${formatEvidenceConnection(connection)}`).join("\n")}`);
    }
    if (relations.length > 0) {
      parts.push(`## Connections between clusters\n${relations.map((relation) =>
        `- "${relation.from}" → "${relation.to}"${relation.label ? ` — "${relation.label}"` : ""}`).join("\n")}`);
    }

    const totalConnections = countConnectionsForEvidence(board, evidence);
    const truncation = {
      remainingEvidence: remaining,
      omittedConnections: totalConnections - connections.length,
      omittedRelations: allRelations.length - relations.length,
      omittedTextConnections: totalConnections - connections.length,
      omittedTextRelations: allRelations.length - relations.length,
    };
    return {
      contextText: boundedText(parts.join("\n\n"), options.maxChars),
      clusters,
      relations: relations.length ? relations : undefined,
      snapshotId: retrieved.snapshotId,
      evidence: evidence.map(compactEvidence),
      connections,
      totalMatched: retrieved.evidence.length,
      truncated: Object.values(truncation).some((count) => count > 0) || evidence.some((item) => item.truncated),
      truncation,
      nextCursor: remaining > 0 && evidence.length > 0
        ? encodeCursor({ v: 1, snapshot: retrieved.snapshotId, query, result: resultFingerprint, offset: nextOffset, page: page + 1 })
        : undefined,
    };
  }

  function pagePosition(shown: number, remaining: number): string {
    if (remaining <= 0) return `Page ${page} of ${page}; no excerpts remaining.`;
    const pages = page + Math.ceil(remaining / shown);
    return `Page ${page} of about ${pages}; ${remaining} excerpt${remaining === 1 ? "" : "s"} remaining; pass nextCursor to continue.`;
  }

  /** Excerpts grouped by cluster in order of first appearance; shared location printed once. */
  function renderGroups(evidence: Evidence[]): string[] {
    const groups = new Map<string, Evidence[]>();
    for (const item of evidence) {
      const key = item.clusterId ?? "";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups].map(([clusterId, items]) => {
      const cluster = clustersById.get(clusterId);
      const locations = new Set(items.map(location));
      const sharedLocation = locations.size === 1 ? [...locations][0]! : "";
      const heading = cluster ? `## Cluster: ${boundedText(cluster.label, 160)}` : "## Outside clusters";
      return [sharedLocation ? `${heading}\n${sharedLocation}` : heading,
        ...items.map((item) => renderEntry(item, locations.size === 1))].join("\n\n");
    });
  }

  function renderEntry(item: Evidence, locationShown: boolean): string {
    const provenance = item.modelDerived ? "MODEL INTERPRETATION — verify against original" :
      item.sourceType === "board_metadata" ? "original metadata" : "original";
    const metadata = [
      item.nodeName && !nameRepeatsText(item) ? `Node name: ${item.nodeName}` : undefined,
      locationShown ? undefined : location(item) || undefined,
      item.sourceType === "table_cell" && item.renderNodeId ? `Table node: ${item.renderNodeId}` : undefined,
      item.row !== undefined ? `Row index: ${item.row}` : undefined,
      item.column !== undefined ? `Column index: ${item.column}` : undefined,
    ].filter(Boolean).join("; ");
    const lines = [`[${item.evidenceId}] ${provenance} · node ${item.nodeId} · ${item.url}`];
    if (metadata) lines.push(metadata);
    lines.push(item.text);
    if (item.truncated) lines.push(partHint(item));
    return lines.join("\n");
  }

  function partHint(item: Evidence): string {
    const total = partCount(item);
    const shortened = item.text !== candidates.find((entry) => entry.evidenceId === item.evidenceId)?.text;
    const prefix = shortened ? "Shortened to fit maxChars. " : "";
    const position = `Part ${item.chunkIndex + 1} of ${total}`;
    if (requestedNodes.has(item.nodeId) && !shortened) return `[${position}.]`;
    return `[${prefix}${position} — request get_board_context with nodeIds: ${JSON.stringify([item.nodeId])} for all parts.]`;
  }

  /** Parts are the chunks a nodeIds request returns for the same source. */
  function partCount(item: Evidence): number {
    const key = `${item.sourceType}\0${item.nodeId}\0${item.clusterId ?? ""}`;
    let count = partCounts.get(key);
    if (count === undefined) {
      count = retrieveEvidence(board, { nodeIds: [item.nodeId] }).evidence.filter((entry) =>
        entry.nodeId === item.nodeId && entry.sourceType === item.sourceType && entry.clusterId === item.clusterId).length;
      partCounts.set(key, Math.max(count, item.chunkIndex + 1));
    }
    return partCounts.get(key)!;
  }

  /** Figma names stickies and text after their content; repeating the name adds nothing. */
  function nameRepeatsText(item: Evidence): boolean {
    if (!item.nodeName) return true;
    if (item.sourceType === "board_metadata") return true;
    const name = normalize(item.nodeName.replace(/…$/, ""));
    const fullText = item.sourceType === "table_cell" ? undefined : nodesById.get(item.nodeId)?.text;
    return Boolean(name) && [item.text, fullText].some((text) => text !== undefined && normalize(text).startsWith(name));
  }

  /** Optional fields that repeat information elsewhere in the same response are left out. */
  function compactEvidence(item: Evidence): Evidence {
    const {
      nodeName, pageId: _pageId, sectionIds: _sectionIds, clusterId: _clusterId, clusterLabel: _clusterLabel,
      renderNodeId, sectionNames, ...rest
    } = item;
    return {
      ...rest,
      ...(nodeName && !nameRepeatsText(item) ? { nodeName } : {}),
      ...(sectionNames?.length ? { sectionNames } : {}),
      ...(item.sourceType === "table_cell" && renderNodeId ? { renderNodeId } : {}),
    };
  }
}

function location(item: Evidence): string {
  return [
    item.pageName ? `Page: ${item.pageName}` : undefined,
    item.sectionNames?.length ? `Sections: ${item.sectionNames.join(" / ")}` : undefined,
  ].filter(Boolean).join("; ");
}

/** Deterministic summaries repeat text highlights that the excerpts already contain. */
function compactSummary(cluster: RefinedCluster): string {
  const modelDerived = cluster.summarySource !== "deterministic" || Boolean(cluster.modelId);
  if (modelDerived) return boundedText(cluster.summary, 600);
  const firstSentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(cluster.summary.trim())?.[0] ?? cluster.summary;
  return boundedText(firstSentence.trim(), 240);
}

/** First-page orientation for an unfocused request: size and the largest sections as topics. */
function boardOverview(board: BoardData, evidence: Evidence[]): string {
  const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
  const sections = new Map<string, number>();
  for (const item of evidence) {
    for (const id of new Set(item.sectionIds ?? [])) sections.set(id, (sections.get(id) ?? 0) + 1);
  }
  const largest = [...sections]
    .map(([id, count]) => ({ name: nodesById.get(id)?.name.trim(), count }))
    .filter((section): section is { name: string; count: number } => Boolean(section.name))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, OVERVIEW_SECTION_LIMIT);
  const lines = [
    "## Board overview",
    `${board.clusters.length} cluster${board.clusters.length === 1 ? "" : "s"}, ${evidence.length} excerpt${evidence.length === 1 ? "" : "s"}.`,
  ];
  if (largest.length > 0) {
    lines.push(`Largest sections (excerpts), usable as topic: ${largest.map((section) => `${boundedText(section.name, 80)} (${section.count})`).join("; ")}.`);
  }
  lines.push("Pass topic or nodeIds for smaller, more precise answers.");
  return lines.join("\n");
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
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
      !Number.isSafeInteger(parsed.offset) || parsed.offset! < 0 ||
      (parsed.page !== undefined && (!Number.isSafeInteger(parsed.page) || parsed.page < 1))) throw new Error("invalid fields");
    return parsed as Cursor;
  } catch {
    throw new Error("Invalid context cursor. Start a new context request.");
  }
}

function responseBytes(output: GetBoardContextOutput): number {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: output.contextText }], structuredContent: output }));
}
