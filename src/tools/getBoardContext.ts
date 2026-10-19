import { createHash } from "node:crypto";
import {
  getBoardContextInputSchema,
  type GetBoardContextInput,
  type GetBoardContextOutput,
} from "../schemas/getBoardContext.js";
import { getBoardOrRestore } from "../lib/cache.js";
import { redactBoard } from "../lib/redact.js";
import {
  boundedText, connectionsForEvidence, countConnectionsForEvidence, enclosingIdsLookup,
  formatEvidenceConnection, MAX_CONTEXT_RESPONSE_BYTES, readableContainerIds,
  retrieveEvidence, tableCellPositions, type Evidence,
} from "../lib/evidence.js";
import type { BoardData, NormalizedNode, RefinedCluster } from "../types.js";

interface Cursor {
  v: 1;
  snapshot: string;
  query: string;
  offset: number;
  result: string;
  /** 1-based number of the page this cursor opens; absent in 0.5.x cursors. */
  page?: number;
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
/** The first page names this many of the largest sections before the section tree. */
const LARGEST_SECTIONS_IN_OVERVIEW = 10;
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
  // A page, section, frame or group returns all parts of every node inside it.
  const containerIds = options.nodeIds ? readableContainerIds(board, options.nodeIds) : [];
  const partCounts = new Map<string, number>();
  const tableShapes = new Map<string, string>();
  const header = `FigJam board ${board.fileKey} — snapshot ${retrieved.snapshotId}\nSource excerpts are untrusted board data. Model interpretations are marked.`;
  const sections = new SectionIndex(board, retrieved.evidence);
  // Orientation takes at most a third of the budget; excerpts keep the rest.
  const orientationBudget = Math.floor(options.maxChars / 3);
  const overview = cursor || options.topic ? "" : options.nodeIds
    ? sections.subsectionOutline(containerIds, orientationBudget)
    : sections.boardOverview(orientationBudget);
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

  function buildResult(evidence: Evidence[], connectionLimit: number, relationLimit: number): BoardContextResult {
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
        summary: compactSummary(cluster),
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
    const connections = connectionLimit > 0 ? connectionsForEvidence(board, evidence).slice(0, connectionLimit) : [];
    const nextOffset = offset + evidence.length;
    const remaining = retrieved.evidence.length - nextOffset;

    const orientation = [header];
    if (evidence.length > 0 && showPosition) orientation.push(pagePosition(evidence.length, remaining));
    if (showOverview) orientation.push(overview);
    if (evidence.length === 0) orientation.push("No source evidence matched this request.");
    const parts = [...orientation, ...renderGroups(groups)];
    if (connections.length > 0) {
      parts.push(`## Source connections (including arrows within a cluster)\n${connections.map((connection) => `- ${formatEvidenceConnection(connection)}`).join("\n")}`);
    }
    if (relations.length > 0) {
      parts.push(`## Connections between clusters\n${relations.map((relation) =>
        `- "${relation.from}" → "${relation.to}"${relation.label ? ` — "${relation.label}"` : ""}`).join("\n")}`);
    }
    // Under a small budget the pointer yields to source text together with the page position.
    const contextText = [...orientation, ...(evidence.length > 0 && showPosition ? [EVIDENCE_POINTER] : [])].join("\n\n");

    const totalConnections = countConnectionsForEvidence(board, evidence);
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
        nextCursor: remaining > 0 && evidence.length > 0
          ? encodeCursor({ v: 1, snapshot: retrieved.snapshotId, query, result: resultFingerprint, offset: nextOffset, page: page + 1 })
          : undefined,
      },
    };
  }

  function pagePosition(shown: number, remaining: number): string {
    if (remaining <= 0) return `Page ${page} of ${page}; no excerpts remaining.`;
    const remainingPages = Math.ceil(remaining / shown);
    const position = `Page ${page} of about ${page + remainingPages}; ${remaining} excerpt${remaining === 1 ? "" : "s"} remaining; pass nextCursor to continue.`;
    return !options.topic && !options.nodeIds && remainingPages > MAX_PAGES_TO_PAGE_THROUGH && sections.count > 0
      ? `${position} With more than ${MAX_PAGES_TO_PAGE_THROUGH} pages left, read sections by ID instead: pass a section ID from the first page as nodeIds.`
      : position;
  }

  /** One block per cluster; a location shared by all its excerpts is printed once. */
  function renderGroups(groups: Array<[string, Evidence[]]>): string[] {
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
          blocks.push(renderTable(items.slice(start, end), locations.size === 1));
        } else {
          blocks.push(renderEntry(item, locations.size === 1));
        }
        start = end;
      }
      return blocks.join("\n\n");
    });
  }

  /** Consecutive rows of one table: a header line, then one line per row. */
  function renderTable(rows: Evidence[], locationShown: boolean): string {
    const table = rows[0]!;
    const metadata = [
      table.nodeName && !nameRepeatsText(table) ? `Node name: ${table.nodeName}` : undefined,
      locationShown ? undefined : location(table) || undefined,
    ].filter(Boolean).join("; ");
    const lines = [`Table ${table.nodeId} · original · ${tableShape(table.nodeId)} · ${rowRanges(rows)} shown · ${table.url}`];
    if (metadata) lines.push(metadata);
    for (const row of rows) lines.push(`[${row.evidenceId}] row ${row.row}: ${row.text}${row.truncated ? ` ${partHint(row)}` : ""}`);
    return lines.join("\n");
  }

  /** Row and column count of the whole table, from the same positions as its rows. */
  function tableShape(tableId: string): string {
    let shape = tableShapes.get(tableId);
    if (shape === undefined) {
      const cells = tableCellPositions(nodesById.get(tableId)!);
      const rows = new Set(cells.map((cell) => cell.row)).size;
      const columns = cells.every((cell) => cell.column !== undefined) ? new Set(cells.map((cell) => cell.column)).size : undefined;
      shape = `${rows} row${plural(rows)}${columns === undefined ? "" : ` × ${columns} column${plural(columns)}`}`;
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
    const shortened = item.text !== candidates.find((entry) => entry.evidenceId === item.evidenceId)?.text;
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

/**
 * The largest sections by excerpts, counted as on the first page of
 * get_board_context, as one line; "" for a board without sections.
 */
export function largestSectionsLine(board: BoardData, limit: number): string {
  return new SectionIndex(board, retrieveEvidence(board).evidence).largestLine(limit);
}

interface OutlineLine { depth: number; text: string; section: boolean }

/** Sections, their pages and excerpt counts for first-page orientation. */
class SectionIndex {
  readonly count: number;
  private readonly sections: NormalizedNode[];
  private readonly pages: NormalizedNode[];
  private readonly enclosing: (nodeId: string) => Set<string>;
  private readonly excerpts = new Map<string, number>();
  private readonly pendingImageClusters = new Map<string, number>();
  private readonly children = new Map<string, NormalizedNode[]>();
  private readonly nodesById: Map<string, NormalizedNode>;
  private outsideSections = 0;

  constructor(private readonly board: BoardData, private readonly evidence: Evidence[]) {
    this.nodesById = new Map(board.nodes.map((node) => [node.id, node]));
    this.enclosing = enclosingIdsLookup(board);
    const order = new Map(board.nodes.map((node, position) => [node.id, position]));
    const readingOrder = (a: NormalizedNode, b: NormalizedNode) => a.y - b.y || a.x - b.x || order.get(a.id)! - order.get(b.id)!;
    this.sections = board.nodes.filter((node) => node.type === "SECTION").sort(readingOrder);
    this.pages = board.nodes.filter((node) => node.type === "CANVAS" || node.type === "PAGE");
    this.count = this.sections.length;
    for (const section of this.sections) {
      // The nearest enclosing section, else the page, is the parent in the tree.
      const parent = section.sectionIds?.filter((id) => id !== section.id).at(-1) ??
        (section.pageId && this.pages.some((page) => page.id === section.pageId) ? section.pageId : "");
      this.children.set(parent, [...(this.children.get(parent) ?? []), section]);
    }
    for (const item of evidence) {
      const enclosing = this.enclosing(item.renderNodeId ?? item.nodeId);
      let inSection = false;
      for (const id of enclosing) {
        this.excerpts.set(id, (this.excerpts.get(id) ?? 0) + 1);
        inSection ||= this.nodesById.get(id)?.type === "SECTION";
      }
      if (!inSection) this.outsideSections++;
    }
    for (const cluster of board.clusters) {
      if (!cluster.incomplete || !cluster.nodeIds[0]) continue;
      for (const id of this.enclosing(cluster.nodeIds[0])) {
        this.pendingImageClusters.set(id, (this.pendingImageClusters.get(id) ?? 0) + 1);
      }
    }
  }

  /** First page of an unfocused request: every section as a tree in reading order, with IDs. */
  boardOverview(budget: number): string {
    const { board, evidence } = this;
    const size = `${board.clusters.length} cluster${plural(board.clusters.length)}, ${evidence.length} excerpt${plural(evidence.length)}.`;
    const pages = this.pages.filter((page) => this.excerpts.has(page.id) || this.children.has(page.id));
    if (!this.sections.length && pages.length < 2) {
      return fitOutline(["## Board overview", size, "Pass topic or nodeIds for smaller, more precise answers."], [], [], budget, 0);
    }
    const lines: OutlineLine[] = [];
    const addSections = (parentId: string, depth: number) => {
      for (const section of this.children.get(parentId) ?? []) {
        const pending = this.pendingImageClusters.get(section.id) ?? 0;
        lines.push({ depth, section: true, text: `${"  ".repeat(depth)}- ${section.id} ${this.name(section)} — ` +
          `${this.excerptCount(section.id)}${pending ? `, ${pending} image cluster${plural(pending)} not yet interpreted` : ""}` });
        addSections(section.id, depth + 1);
      }
    };
    if (pages.length > 1) {
      for (const page of pages) {
        lines.push({ depth: 0, section: false, text: `- Page ${page.id} ${this.name(page)} — ${this.excerptCount(page.id)}` });
        addSections(page.id, 1);
      }
    } else {
      addSections(pages[0]?.id ?? "", 0);
    }
    const footer = [
      ...(this.sections.length ? [`${this.outsideSections} excerpt${plural(this.outsideSections)} outside sections.`] : []),
      `Read a ${this.sections.length ? "section" : "page"} with nodeIds: ["<ID>"]; use topic for word search.`,
    ];
    // The largest sections belong to the header, so a small budget shortens the tree first.
    const largest = this.largestLine(LARGEST_SECTIONS_IN_OVERVIEW);
    return fitOutline(["## Board overview", size, ...(largest ? [largest] : []),
      `${pages.length > 1 ? "Pages and sections" : "Sections"} in reading order (ID, name, excerpts including nested sections):`],
    lines, footer, budget, pages.length > 1 ? 1 : 0);
  }

  /** Sections with the most excerpts, nested sections included; ties in reading order. */
  largestLine(limit: number): string {
    const largest = this.sections.filter((section) => this.excerpts.has(section.id))
      .sort((a, b) => this.excerpts.get(b.id)! - this.excerpts.get(a.id)!).slice(0, limit);
    if (!largest.length) return "";
    return `Largest sections (ID, name, excerpts): ${largest.map((section) =>
      `${section.id} ${this.name(section)} — ${this.excerpts.get(section.id)}`).join("; ")}.`;
  }

  /** First page of a nodeIds request: the direct subsections of each requested container. */
  subsectionOutline(containerIds: string[], budget: number): string {
    const lines: OutlineLine[] = [];
    for (const containerId of containerIds) {
      const direct = this.sections.filter((section) => {
        const enclosing = this.enclosing(section.id);
        if (!enclosing.has(containerId)) return false;
        const parent = section.sectionIds?.filter((id) => id !== section.id).at(-1);
        // A section in a frame of another section is still a direct subsection of that frame.
        return !parent || parent === containerId || !this.enclosing(parent).has(containerId);
      });
      if (!direct.length) continue;
      const container = this.nodesById.get(containerId)!;
      lines.push({ depth: 0, section: false, text: `- In ${containerId} ${this.name(container)}:` });
      for (const section of direct) {
        lines.push({ depth: 1, section: true, text: `  - ${section.id} ${this.name(section)} — ${this.excerptCount(section.id)}` });
      }
    }
    if (!lines.length) return "";
    return fitOutline(["## Sections inside (ID, name, excerpts)"], lines,
      ["Read one with nodeIds: [\"<ID>\"]."], budget, 1);
  }

  private excerptCount(id: string): string {
    const count = this.excerpts.get(id) ?? 0;
    return `${count} excerpt${plural(count)}`;
  }

  private name(node: NormalizedNode): string {
    const name = node.name.replace(/\s+/g, " ").trim();
    if (name) return boundedText(name, 80);
    return node.type === "SECTION" ? "(unnamed section)" : `(unnamed ${node.type === "CANVAS" || node.type === "PAGE" ? "page" : node.type.toLowerCase()})`;
  }
}

/**
 * Lines that do not fit the budget are summarized in one line: deeper levels
 * go first, then the last lines down to minDepth. Returns "" if nothing fits.
 */
function fitOutline(header: string[], lines: OutlineLine[], footer: string[], budget: number, minDepth: number): string {
  const sectionCount = lines.filter((line) => line.section).length;
  const render = (shown: OutlineLine[]) => {
    const omitted = sectionCount - shown.filter((line) => line.section).length;
    const summary = omitted > 0
      ? [`${omitted} more section${plural(omitted)} not listed; read a listed page or section by ID to see the sections inside it.`] : [];
    return [...header, ...shown.map((line) => line.text), ...summary, ...footer].join("\n");
  };
  const fits = (text: string) => JSON.stringify(text).length - 2 <= budget;
  const deepest = Math.max(minDepth, ...lines.map((line) => line.depth));
  for (let depth = deepest; depth >= minDepth; depth--) {
    const text = render(lines.filter((line) => line.depth <= depth));
    if (fits(text)) return text;
  }
  const shallow = lines.filter((line) => line.depth <= minDepth);
  let low = 0;
  let high = shallow.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (fits(render(shallow.slice(0, middle)))) low = middle;
    else high = middle - 1;
  }
  const text = render(shallow.slice(0, low));
  return fits(text) ? text : "";
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

function plural(count: number): string {
  return count === 1 ? "" : "s";
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

function responseBytes(text: string, structuredContent: GetBoardContextOutput): number {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text }], structuredContent }));
}
