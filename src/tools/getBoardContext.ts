import { createHash } from "node:crypto";
import {
  getBoardContextInputSchema,
  type GetBoardContextInput,
  type GetBoardContextOutput,
  type ContextEvidence,
} from "../schemas/getBoardContext.js";
import { getBoardOrRestore } from "../lib/cache.js";
import { readBoardHistory } from "../lib/persistentCache.js";
import { redactBoard } from "../lib/redact.js";
import {
  boundedText, connectionsForEvidence, countConnectionsForEvidence, enclosingIdsLookup,
  formatEvidenceConnection, MAX_CONTEXT_RESPONSE_BYTES, readableContainerIds,
  firstTableRow, retrieveEvidence, snapshotIdForBoard, tableCellPositions, unknownNodeIds, type Evidence,
} from "../lib/evidence.js";
import { SectionIndex } from "../lib/sections.js";
import type { BoardData, RefinedCluster } from "../types.js";

/**
 * New cursors are "v2.<f|o>.<page>.<offset>.<snapshot prefix>.<checksum>". The query binds
 * requested detail, and the checksum also binds the actual full/overview representation.
 * Legacy short and Base64url JSON cursors retain their exact former query/checksum rules
 * and always continue full evidence pages.
 */
type ContextRepresentation = "full" | "overview";

interface Cursor {
  version?: 2;
  representation: ContextRepresentation;
  /** 1-based number of the page this cursor opens. */
  page: number;
  offset: number;
  /** The first SNAPSHOT_PREFIX_LENGTH characters of the snapshot ID; the full ID in an older cursor. */
  snapshot: string;
  check?: string;
  query?: string;
  result?: string;
}

const SNAPSHOT_PREFIX_LENGTH = 12;
const CHECKSUM_LENGTH = 12;
const SHORT_CURSOR = /^([1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.([0-9a-f]{12})\.([0-9a-f]{12})$/;
const V2_CURSOR = /^v2\.(f|o)\.([1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.([0-9a-f]{12})\.([0-9a-f]{12})$/;
const CURSOR_MISMATCH = "Cursor does not match this request or was changed. Send nextCursor unchanged with the same topic, " +
  "nodeIds, outsideSections, detail, limit and maxChars, or start again without a cursor (also after an ingest refined the board).";
const CURSOR_SNAPSHOT_GONE = "The snapshot of this cursor is no longer available. Start again without a cursor.";
/** Characters of requested IDs named in a message; the IDs themselves are up to 50 × 200 characters. */
const MAX_IDS_IN_MESSAGE = 300;

/** Excerpts shown on a page and how many of them advance the cursor through the result sequence. */
interface Page {
  evidence: Evidence[];
  consumed: number;
}

/** Where a page starts and what it shows besides its excerpts. */
interface View {
  offset: number;
  page: number;
  candidates: Evidence[];
  overview: boolean;
  position: boolean;
  summaries: boolean;
}

/** Readable text for MCP content and the structured result; maxChars bounds each of them. */
export interface BoardContextResult {
  /** Orientation and excerpts for the selected full or overview representation. */
  text: string;
  /** Orientation in contextText; excerpt text once, in overview.text or evidence. */
  structuredContent: GetBoardContextOutput;
}

/** Shortest prefix of an excerpt that is still worth returning instead of an error. */
const MIN_SHORTENED_EXCERPT_CHARS = 100;
/** Beyond this many remaining pages, reading sections by ID beats paging. */
const MAX_PAGES_TO_PAGE_THROUGH = 5;
const EVIDENCE_POINTER = "Excerpts are in evidence, cluster by cluster; location and summary per cluster are in clusters; arrows are in connections and relations.";

/**
 * Bounded, snapshot-stable pages of source evidence; a topic miss stays empty.
 * Some MCP hosts hand the model only the text content, others only
 * JSON.stringify(structuredContent), so each carries the excerpt text once and
 * maxChars bounds each of them.
 */
export async function getBoardContext(input: GetBoardContextInput): Promise<BoardContextResult> {
  // Also validate cross-field rules here: MCP registration receives a raw field shape.
  const options = getBoardContextInputSchema.parse(input);
  const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
  const query = querySignature(options);
  const cursorQuery = cursor?.version === 2 ? query : legacyQuerySignature(options);
  if (cursor && ((cursor.query !== undefined && cursor.query !== cursorQuery) ||
    (options.snapshotId && !(cursor.check ? options.snapshotId.startsWith(cursor.snapshot) : options.snapshotId === cursor.snapshot)))) {
    throw new Error(CURSOR_MISMATCH);
  }
  const stored = cursor && !options.snapshotId ? await cursorBoard(options.boardId, cursor)
    : await getBoardOrRestore(options.boardId, options.snapshotId);
  if (!stored) throw new Error(`Board "${options.boardId}" not found — run ingest_board first.`);
  // Snapshots cached before redaction existed are redacted here too.
  const board = redactBoard(stored);
  const retrieved = retrieveEvidence(board, {
    query: options.topic, nodeIds: options.nodeIds, outsideSections: options.outsideSections,
    includeNeighbors: Boolean(options.topic), neighborLimit: 6,
  });
  const unknownIds = options.nodeIds ? unknownNodeIds(board, options.nodeIds) : [];
  if (options.nodeIds && unknownIds.length === new Set(options.nodeIds).size) {
    throw new Error(`${unknownIds.length === 1 ? "No node with ID" : "No nodes with IDs"} ${listIds(unknownIds)} in snapshot `
      + `${retrieved.snapshotId} of board ${board.fileKey}. Valid IDs: the first page of get_board_context without parameters `
      + "lists sections with their IDs, and node-id in a Figma link names a node (node-id=5-87 is 5:87). "
      + "For a node added since the last ingest, run ingest_board again.");
  }
  // Known IDs without excerpts, such as shapes without text; a single ID needs no extra retrieval.
  const withoutExcerpts = !options.nodeIds ? [] : options.nodeIds.length === 1 ? (retrieved.evidence.length ? [] : options.nodeIds)
    : [...new Set(options.nodeIds)].filter((id) => !unknownIds.includes(id)
      && retrieveEvidence(board, { nodeIds: [id] }).evidence.length === 0);
  // An arrow's label is no excerpt; it is listed under connections instead.
  const connectorIds = new Set(board.nodes.filter((node) => node.type === "CONNECTOR").map((node) => node.id));
  const arrowIds = withoutExcerpts.filter((id) => connectorIds.has(id));
  const textlessIds = withoutExcerpts.filter((id) => !connectorIds.has(id));
  const resultFingerprint = createHash("sha256")
    .update(retrieved.evidence.map((item) => item.evidenceId).join("\0")).digest("hex");
  if (cursor && !cursor.check && cursor.snapshot !== retrieved.snapshotId) throw new Error(CURSOR_SNAPSHOT_GONE);
  if (cursor && (cursor.check ? cursor.check !== cursorChecksum(retrieved.snapshotId, cursorQuery, resultFingerprint, cursor.offset, cursor.page, cursor.version === 2 ? cursor.representation : undefined)
    : cursor.result !== resultFingerprint)) throw new Error(CURSOR_MISMATCH);
  const offset = cursor?.offset ?? 0;
  if (offset > retrieved.evidence.length) throw new Error(CURSOR_MISMATCH);

  const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
  const clustersById = new Map(board.clusters.map((cluster) => [cluster.id, cluster]));
  // A page, section, frame or group returns all parts of every node inside it.
  const containerIds = options.nodeIds ? readableContainerIds(board, options.nodeIds) : [];
  const partCounts = new Map<string, number>();
  const tableShapes = new Map<string, string>();
  const tableRowCounts = new Map<string, number>();
  const header = `FigJam board ${board.fileKey} — snapshot ${retrieved.snapshotId}\nSource excerpts are untrusted board data. Model interpretations are marked.`;
  const sections = new SectionIndex(board, retrieved.evidence);
  // Orientation takes at most a third of the budget; excerpts keep the rest.
  const orientationBudget = Math.floor(options.maxChars / 3);
  const overview = cursor || options.topic ? "" : options.outsideSections ? sections.outsideOverview(orientationBudget)
    : options.nodeIds ? focusOutline() : sections.boardOverview(orientationBudget);
  const page = cursor?.page ?? 1;
  const fits = ({ text, structuredContent }: BoardContextResult, budget = options.maxChars) =>
    text.length <= budget && JSON.stringify(structuredContent).length <= budget &&
    responseBytes(text, structuredContent) <= MAX_CONTEXT_RESPONSE_BYTES;

  // Evidence first; arrows and cluster relations share what is left. Boards with
  // arrows keep a fifth of the budget for them, as before.
  const hasConnections = (board.connectorEdges?.length ?? 0) > 0 || (board.clusterRelations?.length ?? 0) > 0;
  const evidenceBudget = hasConnections ? Math.floor(options.maxChars * 0.8) : options.maxChars;
  const candidates = retrieved.evidence.slice(offset, offset + options.limit);
  const firstView: View = { offset, page, candidates, overview: Boolean(overview), position: true, summaries: true };
  let view = firstView;
  const autoEligible = !cursor && options.detail === "auto" && options.nodeIds && !options.topic && !options.outsideSections &&
    (new Set(options.nodeIds).size > 1 || containerIds.length > 0);
  // A validated cursor fixes the representation for the whole sequence, including its last page.
  if (cursor?.representation === "overview") return overviewResult();
  /** Mean excerpts per probe page, for the page estimate; undefined until measured. */
  let perPage: number | undefined;
  let selected: Page;
  try {
    selected = selectWithFallbacks(firstView);
  } catch (error) {
    // If even the minimum full excerpt cannot fit, all excerpts remain unread.
    // Compact lines can still fit when long location metadata prevents a full page.
    if (autoEligible && retrieved.evidence.length > 0 && error instanceof Error &&
      error.message.startsWith("The context budget cannot fit one source excerpt.")) return overviewResult();
    throw error;
  }
  // The remaining pages are estimated from probe pages built like follow-up pages. The estimate
  // changes the position line and with it what fits, so the page is selected again with it.
  for (let round = 0; round < 3 && view.position && offset + selected.consumed < retrieved.evidence.length; round++) {
    const nextOffset = offset + selected.consumed;
    perPage = probePageSize(nextOffset);
    selected = selectWithFallbacks(firstView);
    if (offset + selected.consumed === nextOffset) break;
  }

  // Probe the actual compacted full page, rather than its general truncated flag:
  // arrows, summaries and shortened text alone must never activate an overview.
  if (autoEligible && offset + selected.consumed < retrieved.evidence.length) return overviewResult();

  const connectionCount = maxFitting(countConnectionsForEvidence(board, selected.evidence, "either"), (count) => buildResult(selected, count, 0));
  const relationCount = maxFitting(Math.min(matchingRelations(selected.evidence).length, 50), (count) => buildResult(selected, connectionCount, count));
  const result = buildResult(selected, connectionCount, relationCount);
  if (!fits(result)) {
    throw new Error("The context budget cannot fit one source excerpt. Increase maxChars or request a smaller node.");
  }
  return result;

  /** Compact source lines have the entire budget before optional arrows and relations. */
  function overviewResult(): BoardContextResult {
    const enclosing = enclosingIdsLookup(board);
    const groupOf = new Map<string, string>();
    const headings = new Map<string, { name: string; id: string; page?: { name: string; id: string } }>();
    const order = new Map<string, number>();
    const names = new Map<string, Set<string>>();
    for (const node of board.nodes.filter((node) => node.type === "SECTION")) {
      const name = whitespace(node.name);
      const pages = names.get(name) ?? new Set<string>();
      pages.add(node.pageId ?? "");
      names.set(name, pages);
    }
    for (const item of retrieved.evidence) {
      const around = [...enclosing(item.renderNodeId ?? item.nodeId)]
        .filter((id) => nodesById.get(id)?.type === "SECTION");
      // Recorded section paths and parent chains are both supported by retrieval.
      const sectionId = item.sectionIds?.filter((id) => nodesById.get(id)?.type === "SECTION").at(-1)
        ?? around.reduce<string | undefined>((inner, id) => !inner || enclosing(id).has(inner) ? id : inner, undefined);
      const section = sectionId ? nodesById.get(sectionId) : undefined;
      const pageId = item.pageId ?? [...enclosing(item.renderNodeId ?? item.nodeId)]
        .find((id) => ["PAGE", "CANVAS"].includes(nodesById.get(id)?.type ?? ""));
      const key = sectionId ?? `outside\0${pageId ?? ""}`;
      groupOf.set(item.evidenceId, key);
      if (headings.has(key)) continue;
      const name = section ? whitespace(section.name) || "(unnamed section)" : "Outside sections";
      const pageNode = pageId ? nodesById.get(pageId) : undefined;
      headings.set(key, {
        name, id: sectionId ?? pageId ?? "",
        page: pageNode && (!section || (names.get(name)?.size ?? 0) > 1)
          ? { name: whitespace(pageNode.name), id: pageNode.id } : undefined,
      });
      // Regroup after selection, using the existing container reading order within each group.
      const scope = sectionId ?? pageId;
      const read = scope ? retrieveEvidence(board, { nodeIds: [scope] }).evidence : retrieved.evidence;
      read.forEach((entry, index) => order.set(`${key}\0${entry.evidenceId}`, index));
    }
    const normalized = new Map(retrieved.evidence.map((item) => [item.evidenceId, whitespace(item.text)]));
    const line = (item: Evidence, textLimit: number): string => {
      const parts = item.truncated || item.chunkIndex > 0 ? partCount(item) : 1;
      const markers = [
        item.row === undefined ? "" : ` [row ${item.row}]`,
        item.column === undefined ? "" : ` [column ${item.column}]`,
        parts > 1 ? ` [part ${item.chunkIndex + 1}/${parts}]` : "",
        item.modelDerived ? " [MODEL INTERPRETATION]" : item.sourceType === "board_metadata" ? " [metadata]" : "",
      ].join("");
      return `${item.nodeId}${markers}: ${boundedText(normalized.get(item.evidenceId)!, textLimit)}`;
    };
    const remainingItems = retrieved.evidence.slice(offset);
    let concise = Boolean(cursor);
    // Short orientation and headings yield before any source lines. The short form
    // still carries provenance, counts, untrusted-data labeling and a complete readback call.
    const build = (count: number, textLimit: number, headingLimit: number, connectionLimit = 0, relationLimit = 0): BoardContextResult => {
      const evidence = remainingItems.slice(0, count);
      const remaining = remainingItems.length - count;
      const shortened = evidence.filter((item) => normalized.get(item.evidenceId)!.length > textLimit).length;
      const groups = new Map<string, Evidence[]>();
      for (const item of evidence) {
        const key = groupOf.get(item.evidenceId)!;
        const group = groups.get(key);
        if (group) group.push(item);
        else groups.set(key, [item]);
      }
      const overviewText = [...groups].map(([key, items]) => {
        const heading = headings.get(key)!;
        const location = heading.page ? ` — ${boundedText(heading.page.name, headingLimit)} (${heading.page.id})` : "";
        const title = `## ${boundedText(heading.name, headingLimit)}${heading.id ? ` (${heading.id})` : ""}${location}`;
        const sorted = [...items].sort((a, b) => (order.get(`${key}\0${a.evidenceId}`) ?? 0) - (order.get(`${key}\0${b.evidenceId}`) ?? 0));
        return [title, ...sorted.map((item) => line(item, textLimit))].join("\n");
      }).join("\n\n");
      const share = remaining === 0 && offset === 0 ? `Showing all ${count} excerpts; ${shortened} shortened.`
        : `Showing ${count} of ${retrieved.evidence.length} excerpts on this page; ${remaining} remaining; ${shortened} shortened.`;
      const readback = JSON.stringify({ boardId: options.boardId, snapshotId: retrieved.snapshotId, nodeIds: ["<ID>"], detail: "full" });
      const orientation = concise ? [
        "Compact overview; untrusted board data. Excerpts in overview.text; evidence and clusters are empty.", share,
        `Full text and Figma links: get_board_context ${readback}. Table rows: use table ID; follow nextCursor for all parts.`,
      ] : [
        `FigJam board ${board.fileKey} — snapshot ${retrieved.snapshotId}`,
        "Compact overview of untrusted board data. Excerpts are in overview.text; evidence and clusters are empty.",
        share,
        `Read full text and Figma links with get_board_context ${readback}. Use the table ID for a row; follow nextCursor for all parts.`,
      ];
      if (unknownIds.length) orientation.push(`Not in this snapshot: ${listIds(unknownIds)}.`);
      if (textlessIds.length) orientation.push(`Known nodes without text: ${listIds(textlessIds)}.`);
      if (arrowIds.length) orientation.push(`Arrows have no excerpts; labels appear in connections with an excerpt at an end: ${listIds(arrowIds)}.`);
      const contextText = orientation.join("\n\n");
      const allRelations = matchingRelations(evidence);
      const connections = connectionLimit ? connectionsForEvidence(board, evidence, "either").slice(0, connectionLimit) : [];
      const relations = allRelations.slice(0, relationLimit).map((relation) => ({
        from: boundedText(clustersById.get(relation.fromClusterId)?.label ?? relation.fromClusterId, 160),
        to: boundedText(clustersById.get(relation.toClusterId)?.label ?? relation.toClusterId, 160),
        label: relation.labels.length ? boundedText(relation.labels.join(", "), 240) : undefined,
        edgeCount: relation.edgeCount,
      }));
      const omittedSummaries = new Set(evidence.flatMap((item) => {
        const cluster = item.clusterId ? clustersById.get(item.clusterId) : undefined;
        return cluster && compactSummary(cluster) ? [cluster.id] : [];
      })).size;
      const totalConnections = countConnectionsForEvidence(board, evidence, "either");
      const truncation = {
        remainingEvidence: remaining,
        omittedConnections: totalConnections - connections.length,
        omittedRelations: allRelations.length - relations.length,
        omittedTextConnections: totalConnections - connections.length,
        omittedTextRelations: allRelations.length - relations.length,
        ...(omittedSummaries ? { omittedSummaries } : {}),
      };
      const extra = [
        ...(connections.length ? [`## Source connections\n${connections.map(formatEvidenceConnection).join("\n")}`] : []),
        ...(relations.length ? [`## Connections between clusters\n${relations.map((relation) =>
          `${relation.from} → ${relation.to}${relation.label ? ` — ${relation.label}` : ""}`).join("\n")}`] : []),
      ];
      return {
        text: [contextText, overviewText, ...extra].filter(Boolean).join("\n\n"),
        structuredContent: {
          contextText, snapshotId: retrieved.snapshotId, evidence: [], clusters: [], connections,
          ...(relations.length ? { relations } : {}),
          overview: { text: overviewText, shownEvidence: count, shortenedEvidence: shortened, textLimit },
          totalMatched: retrieved.evidence.length,
          ...(unknownIds.length ? { unknownNodeIds: unknownIds } : {}),
          truncated: shortened > 0 || Object.values(truncation).some((value) => value > 0) || evidence.some((item) => item.truncated),
          truncation,
          ...(remaining > 0 ? { nextCursor: encodeCursor(retrieved.snapshotId, query, resultFingerprint, offset + count, page + 1, "overview") } : {}),
        },
      };
    };
    let count = remainingItems.length;
    let textLimit = 50;
    let headingLimit = 12;
    if (!cursor) {
      // First try the largest prefix while yielding long headings, then find the
      // greatest common prefix using the shortest useful headings.
      for (const presentation of [{ length: 80, concise: false }, { length: 24, concise: false }, { length: 12, concise: true }]) {
        concise = presentation.concise;
        if (fits(build(count, 120, presentation.length))) { textLimit = 120; headingLimit = presentation.length; break; }
      }
      if (textLimit !== 120) {
        for (let length = 119; length >= 50; length--) {
          if (fits(build(count, length, headingLimit))) { textLimit = length; break; }
        }
      }
    }
    if (!fits(build(count, textLimit, headingLimit))) {
      let low = 0;
      let high = count - 1;
      while (low < high) {
        const middle = (low + high + 1) >>> 1;
        if (fits(build(middle, 50, headingLimit))) low = middle;
        else high = middle - 1;
      }
      count = low;
      textLimit = 50;
    }
    if (count === 0 || !fits(build(count, textLimit, headingLimit))) {
      throw new Error("The context budget cannot fit one overview excerpt. Increase maxChars or request a smaller node.");
    }
    const evidence = remainingItems.slice(0, count);
    const connectionCount = maxFitting(countConnectionsForEvidence(board, evidence, "either"), (connections) =>
      build(count, textLimit, headingLimit, connections));
    const relationCount = maxFitting(Math.min(matchingRelations(evidence).length, 50), (relations) =>
      build(count, textLimit, headingLimit, connectionCount, relations));
    return build(count, textLimit, headingLimit, connectionCount, relationCount);
  }

  /**
   * The longest page that fits. Orientation yields to source text under a small budget: overview
   * first, then the page position, then the model summaries of the clusters on the page.
   */
  function selectWithFallbacks(base: View): Page {
    view = base;
    let selection = selectPage();
    for (const hidden of ["overview", "position", "summaries"] as const) {
      if (view.candidates.length === 0 || selection.consumed > 0) return selection;
      if (!view[hidden]) continue;
      view = { ...view, [hidden]: false };
      selection = selectPage();
    }
    if (view.candidates.length === 0 || selection.consumed > 0) return selection;
    const shortened = shortenToFit(view.candidates[0]!);
    if (!shortened) {
      throw new Error("The context budget cannot fit one source excerpt. Increase maxChars or request a smaller node.");
    }
    return { evidence: [shortened], consumed: 1 };
  }

  /**
   * Mean excerpts per page of up to three probe pages: at nextOffset and after one and two thirds
   * of the remaining excerpts, each built like a follow-up page. A later probe that reaches the
   * end holds fewer excerpts than a page could, so it does not count.
   */
  function probePageSize(nextOffset: number): number {
    const total = retrieved.evidence.length;
    const starts = [...new Set([0, 1, 2].map((third) => nextOffset + Math.floor((total - nextOffset) * third / 3)))];
    const sizes: number[] = [];
    const current = view;
    try {
      for (const start of starts) {
        const probe: View = { offset: start, page: page + 1, candidates: retrieved.evidence.slice(start, start + options.limit),
          overview: false, position: true, summaries: true };
        let consumed: number;
        try {
          consumed = selectWithFallbacks(probe).consumed;
        } catch {
          consumed = 1;
        }
        if (start + consumed >= total && sizes.length > 0) break;
        sizes.push(consumed);
        if (start + consumed >= total) break;
      }
    } finally {
      view = current;
    }
    return sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
  }

  /** Requested IDs that share every page with their excerpt counts, then the direct subsections. */
  function focusOutline(): string {
    const requested = retrieved.requestedCounts ? sections.requestedOutline(retrieved.requestedCounts, orientationBudget) : "";
    const used = requested ? JSON.stringify(`${requested}\n\n`).length - 2 : 0;
    return [requested, sections.subsectionOutline(containerIds, orientationBudget - used)].filter(Boolean).join("\n\n");
  }

  /**
   * The longest run of candidates that fits limit and maxChars. A table whose first
   * row is not among them repeats it before its first shown row: that row counts
   * against limit and maxChars, not for the cursor. The first candidate comes
   * without it if both do not fit, so every page advances.
   */
  function selectPage(): Page {
    const sequence: Evidence[] = [];
    const withoutFirstRow = new Set<string>();
    let selection: Page = { evidence: [], consumed: 0 };
    for (const item of view.candidates) {
      // The first excerpt may use the whole budget; arrows then get what is left.
      const budget = sequence.length ? evidenceBudget : options.maxChars;
      let next = withFirstRows([...sequence, item], withoutFirstRow);
      if (!pageFits(next, budget) && !sequence.length && item.sourceType === "table_row") {
        withoutFirstRow.add(item.nodeId);
        next = withFirstRows([item], withoutFirstRow);
      }
      if (!pageFits(next, budget)) break;
      sequence.push(item);
      selection = next;
    }
    return selection;
  }

  function pageFits(selection: Page, budget: number): boolean {
    return selection.evidence.length <= options.limit && fits(buildResult(selection, 0, 0), budget);
  }

  /** The sequence with the first row of each table it continues; nothing appears twice. */
  function withFirstRows(sequence: Evidence[], withoutFirstRow: ReadonlySet<string>): Page {
    const shown = new Set(sequence.map((item) => item.evidenceId));
    const tables = new Set<string>();
    const evidence: Evidence[] = [];
    for (const item of sequence) {
      if (item.sourceType === "table_row" && !tables.has(item.nodeId)) {
        tables.add(item.nodeId);
        const firstRow = firstTableRow(board, item.nodeId);
        if (!withoutFirstRow.has(item.nodeId) && !firstRow.some((row) => shown.has(row.evidenceId))) evidence.push(...firstRow);
      }
      evidence.push(item);
    }
    return { evidence, consumed: sequence.length };
  }

  /** Largest count in [0, total] whose result fits; count 0 is the fallback. */
  function maxFitting(total: number, build: (count: number) => BoardContextResult): number {
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
    const alone = (length: number): Page => ({ evidence: [variant(length)], consumed: 1 });
    if (!fits(buildResult(alone(minimum), 0, 0))) return undefined;
    let low = minimum;
    let high = item.text.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (fits(buildResult(alone(middle), 0, 0))) low = middle;
      else high = middle - 1;
    }
    return variant(low);
  }

  function matchingRelations(evidence: Evidence[]) {
    const clusterIds = new Set(evidence.map((item) => item.clusterId));
    return (board.clusterRelations ?? [])
      .filter((relation) => clusterIds.has(relation.fromClusterId) && clusterIds.has(relation.toClusterId));
  }

  function buildResult({ evidence, consumed }: Page, connectionLimit: number, relationLimit: number): BoardContextResult {
    const groups = groupByCluster(evidence);
    const labels = new Map<string, string>();
    const clusterLocations = new Map<string, string>();
    const clusters = groups.flatMap(([clusterId, items]) => {
      const cluster = clustersById.get(clusterId);
      if (!cluster) return [];
      const label = boundedText(cluster.label, 160);
      const { pageName, sectionNames } = commonLocation(items);
      labels.set(clusterId, label);
      clusterLocations.set(clusterId, locationKey({ pageName, sectionNames }));
      return [{
        label,
        phase: cluster.phase ? boundedText(cluster.phase, 80) : undefined,
        ...(pageName ? { pageName } : {}),
        ...(sectionNames?.length ? { sectionNames } : {}),
        summary: view.summaries ? compactSummary(cluster) : "",
        summarySource: cluster.summarySource ?? "unknown" as const,
        modelDerived: cluster.summarySource !== "deterministic" || Boolean(cluster.modelId),
        sourceNodeIds: [...new Set(items.map((item) => item.nodeId))],
      }];
    });
    const allRelations = matchingRelations(evidence);
    const relations = allRelations.slice(0, relationLimit).map((relation) => ({
      from: labels.get(relation.fromClusterId)!,
      to: labels.get(relation.toClusterId)!,
      label: relation.labels.length ? boundedText(relation.labels.join(", "), 240) : undefined,
      edgeCount: relation.edgeCount,
    }));
    // An arrow appears once one of its ends is on this page; the other end is named by its short text.
    const connections = connectionLimit > 0 ? connectionsForEvidence(board, evidence, "either").slice(0, connectionLimit) : [];
    // Repeated first rows of tables are context; only the result sequence advances the cursor.
    const nextOffset = view.offset + consumed;
    const remaining = retrieved.evidence.length - nextOffset;

    const orientation = [header];
    orientation.push(remaining === 0 && view.offset === 0
      ? `Showing all ${consumed} excerpts.`
      : `Showing ${consumed} of ${retrieved.evidence.length} excerpts on this page; ${remaining} remaining.`);
    if (evidence.length > 0 && view.position) orientation.push(pagePosition(consumed, remaining));
    if (view.overview) orientation.push(overview);
    if (unknownIds.length) orientation.push(`Not in this snapshot: ${listIds(unknownIds)}.`);
    if (textlessIds.length) {
      orientation.push(`${textlessIds.length === 1 ? "This node contains" : "These nodes contain"} no text, for example a shape `
        + `or image without text: ${listIds(textlessIds)}.`);
    }
    if (arrowIds.length) {
      orientation.push("Arrows have no excerpts; an arrow and its label are listed under connections on pages with an excerpt "
        + `at one of its ends: ${listIds(arrowIds)}.`);
    }
    if (evidence.length === 0 && !options.nodeIds) orientation.push("No source evidence matched this request.");
    const parts = [...orientation, ...renderGroups(groups, shownRows(evidence))];
    if (connections.length > 0) {
      parts.push(`## Source connections (including arrows within a cluster; «text» names an end not on this page)\n${connections.map((connection) => `- ${formatEvidenceConnection(connection)}`).join("\n")}`);
    }
    if (relations.length > 0) {
      parts.push(`## Connections between clusters\n${relations.map((relation) =>
        `- "${relation.from}" → "${relation.to}"${relation.label ? ` — "${relation.label}"` : ""}`).join("\n")}`);
    }
    // Under a small budget the pointer yields to source text together with the page position.
    const contextText = [...orientation, ...(evidence.length > 0 && view.position ? [EVIDENCE_POINTER] : [])].join("\n\n");

    const totalConnections = countConnectionsForEvidence(board, evidence, "either");
    // Clusters whose model summary yields to source text under a small budget.
    const omittedSummaries = view.summaries ? 0 : groups.filter(([clusterId]) => {
      const cluster = clustersById.get(clusterId);
      return cluster !== undefined && compactSummary(cluster) !== "";
    }).length;
    const truncation = {
      remainingEvidence: remaining,
      omittedConnections: totalConnections - connections.length,
      omittedRelations: allRelations.length - relations.length,
      omittedTextConnections: totalConnections - connections.length,
      omittedTextRelations: allRelations.length - relations.length,
      ...(omittedSummaries > 0 ? { omittedSummaries } : {}),
    };
    return {
      text: parts.join("\n\n"),
      structuredContent: {
        contextText,
        clusters,
        relations: relations.length ? relations : undefined,
        snapshotId: retrieved.snapshotId,
        evidence: groups.flatMap(([clusterId, items]) => items.map((item) => compactEvidence(item, clusterLocations.get(clusterId)))),
        connections,
        totalMatched: retrieved.evidence.length,
        ...(unknownIds.length ? { unknownNodeIds: unknownIds } : {}),
        truncated: Object.values(truncation).some((count) => count > 0) || evidence.some((item) => item.truncated),
        truncation,
        nextCursor: remaining > 0 && consumed > 0
          ? encodeCursor(retrieved.snapshotId, query, resultFingerprint, nextOffset, view.page + 1)
          : undefined,
      },
    };
  }

  function pagePosition(shown: number, remaining: number): string {
    if (remaining <= 0) return `Page ${view.page} of ${view.page}; no excerpts remaining.`;
    const remainingPages = Math.ceil(remaining / (perPage ?? shown));
    const position = `Page ${view.page} of about ${view.page + remainingPages}; ${remaining} excerpt${remaining === 1 ? "" : "s"} remaining; pass nextCursor to continue.`;
    return !options.topic && !options.nodeIds && !options.outsideSections && remainingPages > MAX_PAGES_TO_PAGE_THROUGH && sections.count > 0
      ? `${position} With more than ${MAX_PAGES_TO_PAGE_THROUGH} pages left, read sections by ID instead: pass a section ID from the first page as nodeIds.`
      : position;
  }

  /** One block per cluster; a location shared by all its excerpts is printed once. */
  function renderGroups(groups: Array<[string, Evidence[]]>, rowsOnPage: Map<string, Set<number>>): string[] {
    return groups.map(([clusterId, items]) => {
      const cluster = clustersById.get(clusterId);
      const locations = new Set(items.map(location));
      const sharedLocation = locations.size === 1 ? [...locations][0]! : "";
      const heading = cluster ? `## Cluster: ${boundedText(cluster.label, 160)}` : "## Outside clusters";
      const blocks = [sharedLocation ? `${heading}\n${sharedLocation}` : heading];
      for (let start = 0; start < items.length;) {
        const item = items[start]!;
        let end = start + 1;
        if (item.sourceType === "table_row") {
          while (end < items.length && items[end]!.sourceType === "table_row" && items[end]!.nodeId === item.nodeId) end++;
          blocks.push(renderTable(items.slice(start, end), locations.size === 1, rowsOnPage.get(item.nodeId)!));
        } else {
          blocks.push(renderEntry(item, locations.size === 1));
        }
        start = end;
      }
      return blocks.join("\n\n");
    });
  }

  /**
   * Consecutive rows of one table: a header line, then one line per row. A page
   * with only some rows of the table names the request for all of them, unless
   * this request names the table or one of its cells.
   */
  function renderTable(rows: Evidence[], locationShown: boolean, rowsOnPage: Set<number>): string {
    const table = rows[0]!;
    const metadata = [
      table.nodeName && !nameRepeatsText(table) ? `Node name: ${table.nodeName}` : undefined,
      locationShown ? undefined : location(table) || undefined,
    ].filter(Boolean).join("; ");
    const allRows = rowsOnPage.size < tableRowCount(table.nodeId) && !requestNamesTable(table.nodeId)
      ? ` · request get_board_context with nodeIds: ${JSON.stringify([table.nodeId])} for all rows` : "";
    const lines = [`Table ${table.nodeId} · original · ${tableShape(table.nodeId)} · ${rowRanges(rows)} shown · ${table.url}${allRows}`];
    if (metadata) lines.push(metadata);
    for (const row of rows) lines.push(`[${row.evidenceId}] row ${row.row}: ${row.text}${row.truncated ? ` ${partHint(row)}` : ""}`);
    return lines.join("\n");
  }

  /** Row numbers on this page by table. */
  function shownRows(evidence: Evidence[]): Map<string, Set<number>> {
    const rows = new Map<string, Set<number>>();
    for (const item of evidence) {
      if (item.sourceType !== "table_row") continue;
      const tableRows = rows.get(item.nodeId) ?? new Set<number>();
      tableRows.add(item.row!);
      rows.set(item.nodeId, tableRows);
    }
    return rows;
  }

  /** Rows of a table that have excerpts, as a nodeIds request for the table returns them. */
  function tableRowCount(tableId: string): number {
    let count = tableRowCounts.get(tableId);
    if (count === undefined) {
      count = new Set(retrieveEvidence(board, { nodeIds: [tableId] }).evidence
        .filter((item) => item.sourceType === "table_row" && item.nodeId === tableId).map((item) => item.row)).size;
      tableRowCounts.set(tableId, count);
    }
    return count;
  }

  function requestNamesTable(tableId: string): boolean {
    const table = nodesById.get(tableId);
    const ids = [tableId, table?.renderNodeId, ...(table?.table?.cells.map((cell) => cell.id) ?? [])];
    return Boolean(options.nodeIds?.some((id) => ids.includes(id)));
  }

  /** Row and column count of the whole table, from the same positions as its rows. */
  function tableShape(tableId: string): string {
    let shape = tableShapes.get(tableId);
    if (shape === undefined) {
      const cells = tableCellPositions(nodesById.get(tableId)!);
      const rows = new Set(cells.map((cell) => cell.row)).size;
      const columns = cells.every((cell) => cell.column !== undefined) ? new Set(cells.map((cell) => cell.column)).size : undefined;
      shape = `${rows} row${rows === 1 ? "" : "s"}${columns === undefined ? "" : ` × ${columns} column${columns === 1 ? "" : "s"}`}`;
      tableShapes.set(tableId, shape);
    }
    return shape;
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
    // Only shortenToFit changes text, and only that of the first candidate.
    const shortened = item.evidenceId === view.candidates[0]?.evidenceId && item.text !== view.candidates[0].text;
    const prefix = shortened ? "Shortened to fit maxChars. " : "";
    const position = `Part ${item.chunkIndex + 1} of ${total}`;
    // A nodeIds request returns every part of each source it matches.
    if (options.nodeIds && !shortened) return `[${position}.]`;
    const scope = item.sourceType === "table_row" ? "the whole table" : "all parts";
    return `[${prefix}${position} — request get_board_context with nodeIds: ${JSON.stringify([item.nodeId])} for ${scope}.]`;
  }

  /** Parts are the chunks a nodeIds request returns for the same source. */
  function partCount(item: Evidence): number {
    const key = `${item.sourceType}\0${item.nodeId}\0${item.clusterId ?? ""}\0${item.row ?? ""}`;
    let count = partCounts.get(key);
    if (count === undefined) {
      count = retrieveEvidence(board, { nodeIds: [item.nodeId] }).evidence.filter((entry) =>
        entry.nodeId === item.nodeId && entry.sourceType === item.sourceType && entry.clusterId === item.clusterId &&
        entry.row === item.row).length;
      partCounts.set(key, Math.max(count, item.chunkIndex + 1));
    }
    return partCounts.get(key)!;
  }

  /** Figma names stickies and text after their content; repeating the name adds nothing. */
  function nameRepeatsText(item: Evidence): boolean {
    if (!item.nodeName) return true;
    if (item.sourceType === "board_metadata") return true;
    const name = normalize(item.nodeName.replace(/…$/, ""));
    const fullText = item.sourceType === "table_cell" || item.sourceType === "table_row" ? undefined : nodesById.get(item.nodeId)?.text;
    return Boolean(name) && [item.text, fullText].some((text) => text !== undefined && normalize(text).startsWith(name));
  }

  /**
   * Optional fields that repeat information elsewhere in the same response are left out.
   * The location stays only outside a listed cluster or where it differs from the cluster's.
   */
  function compactEvidence(item: Evidence, clusterLocation: string | undefined): ContextEvidence {
    const {
      nodeName, pageId: _pageId, sectionIds: _sectionIds, clusterId: _clusterId, clusterLabel: _clusterLabel,
      renderNodeId, pageName, sectionNames, snapshotId: _snapshotId, chunkIndex, truncated, modelDerived, ...rest
    } = item;
    const ownLocation = clusterLocation === undefined || locationKey(item) !== clusterLocation;
    return {
      ...rest,
      ...(chunkIndex !== 0 ? { chunkIndex } : {}),
      ...(truncated ? { truncated } : {}),
      ...(modelDerived ? { modelDerived } : {}),
      ...(nodeName && !nameRepeatsText(item) ? { nodeName } : {}),
      ...(ownLocation && pageName ? { pageName } : {}),
      // An empty list marks an excerpt outside sections in a cluster that has some.
      ...(ownLocation && (sectionNames?.length || clusterLocation !== undefined) ? { sectionNames: sectionNames ?? [] } : {}),
      ...((item.sourceType === "table_cell" || item.sourceType === "table_row") && renderNodeId ? { renderNodeId } : {}),
    };
  }
}

/** Excerpts grouped by cluster in order of first appearance; "" holds those outside clusters. */
function groupByCluster(evidence: Evidence[]): Array<[string, Evidence[]]> {
  const groups = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const key = item.clusterId ?? "";
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups];
}

type Location = Pick<Evidence, "pageName" | "sectionNames">;

function locationKey({ pageName, sectionNames }: Location): string {
  return JSON.stringify([pageName ?? "", sectionNames ?? []]);
}

/** The location most excerpts of a cluster share on this page; ties go to the first. */
function commonLocation(items: Evidence[]): Location {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(locationKey(item), (counts.get(locationKey(item)) ?? 0) + 1);
  const common = items.reduce((best, item) => counts.get(locationKey(item))! > counts.get(locationKey(best))! ? item : best);
  return { pageName: common.pageName, sectionNames: common.sectionNames };
}

function location(item: Evidence): string {
  return [
    item.pageName ? `Page: ${item.pageName}` : undefined,
    item.sectionNames?.length ? `Sections: ${item.sectionNames.join(" / ")}` : undefined,
  ].filter(Boolean).join("; ");
}

/** Deterministic summaries only count and repeat text that the excerpts already carry. */
function compactSummary(cluster: RefinedCluster): string {
  const modelDerived = cluster.summarySource !== "deterministic" || Boolean(cluster.modelId);
  return modelDerived ? boundedText(cluster.summary, 600) : "";
}

/** Row numbers as ranges, for example "rows 0–3, 7" or "row 2". */
function rowRanges(rows: Evidence[]): string {
  const numbers = [...new Set(rows.map((row) => row.row!))].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let start = 0; start < numbers.length;) {
    let end = start;
    while (end + 1 < numbers.length && numbers[end + 1] === numbers[end]! + 1) end++;
    ranges.push(end === start ? String(numbers[start]) : `${numbers[start]}–${numbers[end]}`);
    start = end + 1;
  }
  return `row${numbers.length === 1 ? "" : "s"} ${ranges.join(", ")}`;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Source spelling stays intact; overview lines only normalize whitespace. */
function whitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function querySignature(input: GetBoardContextInput): string {
  return createHash("sha256").update(JSON.stringify([legacyQuerySignature(input), input.detail ?? "auto"])).digest("hex");
}

/** Exact pre-detail signature for existing short and Base64 cursors. */
function legacyQuerySignature(input: GetBoardContextInput): string {
  return createHash("sha256").update(JSON.stringify({
    boardId: input.boardId,
    topic: input.topic ?? "",
    // Several IDs take turns on every page in request order, so the order is part of the query.
    nodeIds: input.nodeIds ? [...new Set(input.nodeIds)] : null,
    ...(input.outsideSections ? { outsideSections: true } : {}),
    limit: input.limit ?? 20,
    maxChars: input.maxChars ?? 12000,
  })).digest("hex");
}

function encodeCursor(snapshotId: string, query: string, result: string, offset: number, page: number,
  representation: ContextRepresentation = "full"): string {
  const kind = representation === "overview" ? "o" : "f";
  return `v2.${kind}.${page}.${offset}.${snapshotId.slice(0, SNAPSHOT_PREFIX_LENGTH)}.${cursorChecksum(snapshotId, query, result, offset, page, representation)}`;
}

function cursorChecksum(snapshotId: string, query: string, result: string, offset: number, page: number,
  representation?: ContextRepresentation): string {
  const fields: Array<string | number> = [snapshotId, query, result, offset, page];
  if (representation !== undefined) fields.push("v2", representation);
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, CHECKSUM_LENGTH);
}

function decodeCursor(value: string): Cursor {
  const versioned = V2_CURSOR.exec(value);
  if (versioned) return { version: 2, representation: versioned[1] === "o" ? "overview" : "full",
    page: Number(versioned[2]), offset: Number(versioned[3]), snapshot: versioned[4]!, check: versioned[5]! };
  const short = SHORT_CURSOR.exec(value);
  if (short) return { representation: "full", page: Number(short[1]), offset: Number(short[2]), snapshot: short[3]!, check: short[4]! };
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || typeof parsed.snapshot !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.snapshot) ||
      typeof parsed.query !== "string" || !/^[a-f0-9]{64}$/.test(parsed.query) ||
      typeof parsed.result !== "string" || !/^[a-f0-9]{64}$/.test(parsed.result) ||
      !Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0 ||
      (parsed.page !== undefined && (!Number.isSafeInteger(parsed.page) || (parsed.page as number) < 1))) throw new Error("invalid fields");
    // Cursors of 0.5.x carry no page.
    return { representation: "full", page: (parsed.page as number | undefined) ?? 1, offset: parsed.offset as number, snapshot: parsed.snapshot,
      query: parsed.query, result: parsed.result };
  } catch {
    throw new Error(CURSOR_MISMATCH);
  }
}

/** The cursor's snapshot: the latest board if it matches, else the newest matching snapshot in the board's history. */
async function cursorBoard(boardId: string, cursor: Cursor): Promise<BoardData | undefined> {
  if (!cursor.check) return getBoardOrRestore(boardId, cursor.snapshot);
  const latest = await getBoardOrRestore(boardId);
  if (!latest || snapshotIdForBoard(latest).startsWith(cursor.snapshot)) return latest;
  const snapshotId = (await readBoardHistory(boardId)).findLast((entry) => entry.snapshotId?.startsWith(cursor.snapshot))?.snapshotId;
  if (!snapshotId) throw new Error(CURSOR_SNAPSHOT_GONE);
  return getBoardOrRestore(boardId, snapshotId);
}

function responseBytes(text: string, structuredContent: GetBoardContextOutput): number {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text }], structuredContent }));
}

function listIds(ids: string[]): string {
  return boundedText(ids.join(", "), MAX_IDS_IN_MESSAGE);
}
