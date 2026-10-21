import { createHash } from "node:crypto";
import {
  getBoardContextInputSchema,
  type GetBoardContextInput,
  type GetBoardContextOutput,
} from "../schemas/getBoardContext.js";
import { getBoardOrRestore } from "../lib/cache.js";
import { readBoardHistory } from "../lib/persistentCache.js";
import { redactBoard } from "../lib/redact.js";
import {
  boundedText, connectionsForEvidence, countConnectionsForEvidence,
  formatEvidenceConnection, MAX_CONTEXT_RESPONSE_BYTES, readableContainerIds,
  firstTableRow, retrieveEvidence, snapshotIdForBoard, tableCellPositions, type Evidence,
} from "../lib/evidence.js";
import { SectionIndex } from "../lib/sections.js";
import type { BoardData, RefinedCluster } from "../types.js";

/**
 * nextCursor is "<page>.<offset>.<snapshot prefix>.<checksum>": short enough to copy by hand. The checksum covers
 * the snapshot, query, result sequence, offset and page, so any changed character is detected. Base64url JSON
 * cursors of 0.9.x and older carry the full snapshot ID and the query and result fingerprints instead.
 */
interface Cursor {
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
const CURSOR_MISMATCH = "Cursor does not match this request or was changed. Send nextCursor unchanged with the same topic, " +
  "nodeIds, outsideSections, limit and maxChars, or start again without a cursor (also after an ingest refined the board).";
const CURSOR_SNAPSHOT_GONE = "The snapshot of this cursor is no longer available. Start again without a cursor.";

/** Excerpts shown on a page and how many of them advance the cursor through the result sequence. */
interface Page {
  evidence: Evidence[];
  consumed: number;
}

/** Readable text for MCP content and the structured result; maxChars bounds each of them. */
export interface BoardContextResult {
  /** Orientation and every excerpt grouped by cluster, with links and arrows. */
  text: string;
  /** Orientation in contextText; excerpt text only in evidence, location and summary per cluster. */
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
  if (cursor && ((cursor.query !== undefined && cursor.query !== query) ||
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
  const resultFingerprint = createHash("sha256")
    .update(retrieved.evidence.map((item) => item.evidenceId).join("\0")).digest("hex");
  if (cursor && !cursor.check && cursor.snapshot !== retrieved.snapshotId) throw new Error(CURSOR_SNAPSHOT_GONE);
  if (cursor && (cursor.check ? cursor.check !== cursorChecksum(retrieved.snapshotId, query, resultFingerprint, cursor.offset, cursor.page)
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
  let showOverview = Boolean(overview);
  let showPosition = true;
  let showSummaries = true;
  let selected = selectPage();
  // Orientation yields to source text under a small budget: overview first, then the page
  // position, then the model summaries of the clusters on the page.
  if (candidates.length > 0 && selected.consumed === 0 && showOverview) {
    showOverview = false;
    selected = selectPage();
  }
  if (candidates.length > 0 && selected.consumed === 0) {
    showPosition = false;
    selected = selectPage();
  }
  if (candidates.length > 0 && selected.consumed === 0) {
    showSummaries = false;
    selected = selectPage();
  }
  if (candidates.length > 0 && selected.consumed === 0) {
    const shortened = shortenToFit(candidates[0]!);
    if (!shortened) {
      throw new Error("The context budget cannot fit one source excerpt. Increase maxChars or request a smaller node.");
    }
    selected = { evidence: [shortened], consumed: 1 };
  }

  const connectionCount = maxFitting(countConnectionsForEvidence(board, selected.evidence, "either"), (count) => buildResult(selected, count, 0));
  const relationCount = maxFitting(Math.min(matchingRelations(selected.evidence).length, 50), (count) => buildResult(selected, connectionCount, count));
  const result = buildResult(selected, connectionCount, relationCount);
  if (!fits(result)) {
    throw new Error("The context budget cannot fit one source excerpt. Increase maxChars or request a smaller node.");
  }
  return result;

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
    for (const item of candidates) {
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
        summary: showSummaries ? compactSummary(cluster) : "",
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
    const nextOffset = offset + consumed;
    const remaining = retrieved.evidence.length - nextOffset;

    const orientation = [header];
    if (evidence.length > 0 && showPosition) orientation.push(pagePosition(consumed, remaining));
    if (showOverview) orientation.push(overview);
    if (evidence.length === 0) orientation.push("No source evidence matched this request.");
    const parts = [...orientation, ...renderGroups(groups, shownRows(evidence))];
    if (connections.length > 0) {
      parts.push(`## Source connections (including arrows within a cluster; «text» names an end not on this page)\n${connections.map((connection) => `- ${formatEvidenceConnection(connection)}`).join("\n")}`);
    }
    if (relations.length > 0) {
      parts.push(`## Connections between clusters\n${relations.map((relation) =>
        `- "${relation.from}" → "${relation.to}"${relation.label ? ` — "${relation.label}"` : ""}`).join("\n")}`);
    }
    // Under a small budget the pointer yields to source text together with the page position.
    const contextText = [...orientation, ...(evidence.length > 0 && showPosition ? [EVIDENCE_POINTER] : [])].join("\n\n");

    const totalConnections = countConnectionsForEvidence(board, evidence, "either");
    const truncation = {
      remainingEvidence: remaining,
      omittedConnections: totalConnections - connections.length,
      omittedRelations: allRelations.length - relations.length,
      omittedTextConnections: totalConnections - connections.length,
      omittedTextRelations: allRelations.length - relations.length,
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
        truncated: Object.values(truncation).some((count) => count > 0) || evidence.some((item) => item.truncated),
        truncation,
        nextCursor: remaining > 0 && consumed > 0
          ? encodeCursor(retrieved.snapshotId, query, resultFingerprint, nextOffset, page + 1)
          : undefined,
      },
    };
  }

  function pagePosition(shown: number, remaining: number): string {
    if (remaining <= 0) return `Page ${page} of ${page}; no excerpts remaining.`;
    const remainingPages = Math.ceil(remaining / shown);
    const position = `Page ${page} of about ${page + remainingPages}; ${remaining} excerpt${remaining === 1 ? "" : "s"} remaining; pass nextCursor to continue.`;
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
    const shortened = item.evidenceId === candidates[0]?.evidenceId && item.text !== candidates[0].text;
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
  function compactEvidence(item: Evidence, clusterLocation: string | undefined): Evidence {
    const {
      nodeName, pageId: _pageId, sectionIds: _sectionIds, clusterId: _clusterId, clusterLabel: _clusterLabel,
      renderNodeId, pageName, sectionNames, ...rest
    } = item;
    const ownLocation = clusterLocation === undefined || locationKey(item) !== clusterLocation;
    return {
      ...rest,
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

function querySignature(input: GetBoardContextInput): string {
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

function encodeCursor(snapshotId: string, query: string, result: string, offset: number, page: number): string {
  return `${page}.${offset}.${snapshotId.slice(0, SNAPSHOT_PREFIX_LENGTH)}.${cursorChecksum(snapshotId, query, result, offset, page)}`;
}

function cursorChecksum(snapshotId: string, query: string, result: string, offset: number, page: number): string {
  return createHash("sha256").update(JSON.stringify([snapshotId, query, result, offset, page])).digest("hex").slice(0, CHECKSUM_LENGTH);
}

function decodeCursor(value: string): Cursor {
  const short = SHORT_CURSOR.exec(value);
  if (short) return { page: Number(short[1]), offset: Number(short[2]), snapshot: short[3]!, check: short[4]! };
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || typeof parsed.snapshot !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.snapshot) ||
      typeof parsed.query !== "string" || !/^[a-f0-9]{64}$/.test(parsed.query) ||
      typeof parsed.result !== "string" || !/^[a-f0-9]{64}$/.test(parsed.result) ||
      !Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0 ||
      (parsed.page !== undefined && (!Number.isSafeInteger(parsed.page) || (parsed.page as number) < 1))) throw new Error("invalid fields");
    // Cursors of 0.5.x carry no page.
    return { page: (parsed.page as number | undefined) ?? 1, offset: parsed.offset as number, snapshot: parsed.snapshot,
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
