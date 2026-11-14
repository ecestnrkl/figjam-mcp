import { createHash } from "node:crypto";
import { tableCellPositions } from "./tableCells.js";
export { tableCellPositions } from "./tableCells.js";
import { connectorArrow } from "./connectorGraph.js";
import { GENERIC_NODE_NAMES, isGenericNodeName } from "./nodeTree.js";
import { inClusterReadingOrder, pagePositions } from "./readingOrder.js";
import type { BoardData, ConnectorEdge, NormalizedNode, RefinedCluster, TableCell } from "../types.js";

export const EVIDENCE_CHUNK_CHARS = 1200;
export const MAX_CONTEXT_RESPONSE_BYTES = 128 * 1024;
/** Cells of a table row excerpt are joined with this separator; an empty cell stays an empty slot. */
export const TABLE_CELL_SEPARATOR = " | ";
const MAX_INDEX_ENTRIES = 100_000;
/** Their names already reach every excerpt inside them as pageName and sectionNames. */
const CONTAINER_TYPES = new Set(["DOCUMENT", "CANVAS", "PAGE", "SECTION"]);
/** A nodeIds request for one of these returns every excerpt inside it. */
const READABLE_CONTAINER_TYPES = new Set(["CANVAS", "PAGE", "SECTION", "FRAME", "GROUP"]);
const MAX_ENCLOSING_DEPTH = 1024;

/** Original board text, model interpretations and generated placeholders remain distinguishable at every boundary. */
export interface Evidence {
  evidenceId: string;
  /** Presentation-only context, such as a repeated table heading. */
  context?: true;
  snapshotId: string;
  nodeId: string;
  text: string;
  sourceType: "board_text" | "table_cell" | "table_row" | "board_metadata" | "model_interpretation" | "cluster_summary";
  modelDerived: boolean;
  clusterId?: string;
  clusterLabel?: string;
  /** Internal presentation hint; not a structured response field. */
  clusterLabelModel?: boolean;
  nodeName?: string;
  pageName?: string;
  sectionNames?: string[];
  frameNames?: string[];
  pageId?: string;
  sectionIds?: string[];
  renderNodeId?: string;
  row?: number;
  column?: number;
  chunkIndex: number;
  url: string;
  truncated: boolean;
}

export interface EvidenceConnection {
  connectorId: string;
  fromNodeId: string;
  /** Short text of the start node when it is not among the displayed excerpts. */
  fromText?: string;
  toNodeId: string;
  /** Short text of the end node when it is not among the displayed excerpts. */
  toText?: string;
  direction: NonNullable<ConnectorEdge["direction"]>;
  label?: string;
  url: string;
}

/**
 * "both": arrows between displayed nodes. "either": also arrows with one end displayed
 * or a section, frame or group around a displayed node; never arrows to a page.
 */
export type ConnectionEnds = "both" | "either";
/** An arrow end of these types is on the page when a displayed excerpt lies inside it. */
const ENCLOSING_END_TYPES = new Set(["SECTION", "FRAME", "GROUP"]);
const PAGE_END_TYPES = new Set(["DOCUMENT", "CANVAS", "PAGE"]);

/** Length of the short text that names an end outside the displayed excerpts. */
const END_TEXT_CHARS = 80;

export interface EvidenceQuery {
  query?: string;
  nodeIds?: string[];
  /** Restricts primary matches before bounded one-hop expansion (Q&A). */
  limit?: number;
  includeNeighbors?: boolean;
  neighborLimit?: number;
  /** Bounded cell context for lexical table matches, separate from graph neighbors. */
  tableNeighborLimit?: number;
  /** Every excerpt that lies in no section, cluster by cluster in reading order. */
  outsideSections?: boolean;
}

export interface EvidenceResult {
  snapshotId: string;
  evidence: Evidence[];
  /** Internal selection boundary; never serialized as an MCP response field. */
  primaryEvidenceIds: string[];
  connections: EvidenceConnection[];
  totalMatched: number;
  /**
   * Excerpts per requested ID in request order, when several IDs including a
   * readable container share every page; each excerpt counts for one ID.
   */
  requestedCounts?: Array<{ id: string; count: number }>;
}

const FIELD_WEIGHTS = { text: 1, node: 0.35, section: 0.20, page: 0.10, cluster: 0.05 } as const;
type EvidenceField = keyof typeof FIELD_WEIGHTS;
const FIELDS = Object.keys(FIELD_WEIGHTS) as EvidenceField[];
const ORIGINAL_FIELDS = FIELDS.filter((field) => field !== "cluster");
const MAX_PREFIX_TERMS = 32;
const PREFIX_MATCH_WEIGHT = 0.6;

interface IndexedEvidence {
  evidence: Evidence;
  /** Cells of a table row excerpt; a nodeIds request for one of them returns the row. */
  cellIds?: string[];
  lengths: Record<EvidenceField, number>;
}

type EvidenceSource = Pick<IndexedEvidence, "evidence" | "cellIds">;

interface FieldIndex {
  postings: Map<string, Array<{ index: number; frequency: number }>>;
  averageLength: number;
}

interface EvidenceIndex {
  snapshotId: string;
  entries: IndexedEvidence[];
  fields: Record<EvidenceField, FieldIndex>;
  /** Original-field terms only; a derived label cannot consume the expansion budget. */
  vocabulary: string[];
  reversedVocabulary: string[];
  vocabularySet: Set<string>;
  /** All parts of the first row excerpt of each table, by table ID. */
  firstRows: Map<string, Evidence[]>;
}

// A snapshot is immutable once published by ingest. Weak references let LRU eviction reclaim indexes.
const indexes = new WeakMap<BoardData, EvidenceIndex>();
const segmenter = new Intl.Segmenter("und", { granularity: "word" });
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does", "for", "from",
  "has", "have", "how", "i", "in", "is", "it", "its", "me", "of", "on", "or", "our", "that",
  "the", "their", "there", "these", "this", "to", "was", "we", "were", "what", "when", "where",
  "which", "who", "why", "with", "you", "your", "about", "please", "find", "board", "boards",
  "aber", "als", "am", "an", "auch", "auf", "aus", "bei", "das", "dem", "den", "der", "des",
  "die", "ein", "eine", "einen", "einer", "es", "für", "hat", "haben", "im", "ist", "mit",
  "nach", "nicht", "oder", "sich", "sie", "sind", "über", "um", "und", "vom", "von", "war",
  "welche", "welcher", "welches", "wer", "wie", "wo", "zu", "zum", "zur", "bitte",
  "dass", "laut", "bereits", "gibt", "etwas", "wann", "noch", "steht", "wurde", "wurden",
  "schon", "kann", "wird", "werden", "einem", "eines",
]);

/** Unicode word segmentation supports accented words and scripts without whitespace. */
interface TokenizedWord { lower: string; folded: string; keep: boolean }

export function evidenceTokens(text: string): string[] {
  return tokenizeEvidence(text, new Map());
}

function tokenizeEvidence(text: string, words: Map<string, TokenizedWord>): string[] {
  const input = text.normalize("NFKC").replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "");
  const lowerInput = input.toLowerCase();
  const hasHyphen = /[-‐]/.test(input);
  // Non-Latin, uncased text needs no per-word normalization or compound handling.
  if (!hasHyphen && input === lowerInput && !/\p{Script=Latin}/u.test(input)) {
    return Array.from(segmenter.segment(input)).filter((part) => part.isWordLike)
      .map((part) => part.segment).filter((word) => !STOPWORDS.has(word));
  }
  const tokens: string[] = [];
  const fold = (word: string) => {
    if (!/[^\x00-\x7f]/.test(word) || !/\p{Script=Latin}/u.test(word)) return word;
    if (/^[\p{Script=Latin}\p{M}]+$/u.test(word)) return word.normalize("NFD").replace(/\p{M}/gu, "");
    return word.replace(/\p{Script=Latin}[\p{M}]*/gu, (latin) => latin.normalize("NFD").replace(/\p{M}/gu, ""));
  };
  let compound: string[] = [];
  let afterHyphen = false;
  const flush = () => {
    if (compound.length > 1) tokens.push(fold(compound.join("")));
    compound = [];
    afterHyphen = false;
  };
  for (const part of segmenter.segment(input)) {
    if (part.isWordLike) {
      if (hasHyphen && !afterHyphen) flush();
      let word = words.get(part.segment);
      if (!word) {
        const lower = part.segment.toLowerCase();
        const acronym = part.segment.length >= 2 && part.segment !== lower && part.segment === part.segment.toUpperCase();
        word = { lower, folded: fold(lower), keep: acronym || !STOPWORDS.has(lower) };
        words.set(part.segment, word);
      }
      if (word.keep) tokens.push(word.folded);
      if (hasHyphen) compound.push(word.lower);
      afterHyphen = false;
    } else if (hasHyphen && (part.segment === "-" || part.segment === "‐") && compound.length && !afterHyphen) {
      afterHyphen = true;
    } else if (hasHyphen) {
      flush();
    }
  }
  if (hasHyphen) flush();
  return tokens;
}

export function snapshotIdForBoard(board: BoardData): string {
  if (board.snapshotId) return board.snapshotId;
  // Compatibility for in-memory consumers that have not assigned a persisted snapshot yet.
  // Model summaries participate here because those consumers can have no original nodes.
  return digest(JSON.stringify({
    fileKey: board.fileKey,
    nodeHash: board.nodeHash,
    nodes: board.nodes,
    clusters: board.clusters,
    connectors: board.connectorEdges,
  }));
}

/** All parts of the first row excerpt of a table, the row with its column headings; [] for none. */
export function firstTableRow(board: BoardData, tableId: string): Evidence[] {
  return getIndex(board).firstRows.get(tableId) ?? [];
}

/** Whether retrieval on this board object reuses an index that is already built. */
export function hasEvidenceIndex(board: BoardData): boolean {
  return indexes.has(board);
}

export function nodeLink(board: BoardData, nodeId: string): string {
  return `https://www.figma.com/board/${encodeURIComponent(board.fileKey)}?node-id=${encodeURIComponent(nodeId)}`;
}

/** Field-weighted BM25, scaled by squared query coverage in text, node and section. */
export function retrieveEvidence(board: BoardData, options: EvidenceQuery = {}): EvidenceResult {
  const index = getIndex(board);
  const query = options.query?.trim();
  let matches: IndexedEvidence[];
  let singleWordExactIds: Set<string> | undefined;
  let requestedCounts: EvidenceResult["requestedCounts"];
  if (options.nodeIds) {
    const requested = new Set(options.nodeIds);
    const containers = new Set(readableContainerIds(board, options.nodeIds));
    const enclosing = containers.size ? enclosingIdsLookup(board) : undefined;
    matches = index.entries.filter(({ evidence, cellIds }) =>
      requested.has(evidence.nodeId) || Boolean(evidence.renderNodeId && requested.has(evidence.renderNodeId)) ||
      Boolean(cellIds?.some((id) => requested.has(id))) ||
      Boolean(enclosing && [...enclosing(evidence.renderNodeId ?? evidence.nodeId)].some((id) => containers.has(id))),
    );
    if (enclosing && requested.size > 1) {
      const shared = shareRequestedIds(board, matches, [...requested], containers, enclosing);
      matches = shared.entries;
      requestedCounts = shared.counts;
    } else if (containers.size) {
      matches = contentFirst(readingOrder(board, matches), (entry) => entry.evidence);
    }
  } else if (options.outsideSections) {
    const inSection = inSectionLookup(board);
    matches = contentFirst(readingOrder(board, index.entries.filter(({ evidence }) => !inSection(evidence))), (entry) => entry.evidence);
  } else if (query) {
    const queryTerms = [...new Set(evidenceTokens(query))];
    const alternatives = new Map(queryTerms.map((term) => [term, wordAlternatives(index, term)]));
    const exactEntries = new Map(queryTerms.map((term) => [term, new Set(
      (["text", "node", "section"] as const).flatMap((field) => (index.fields[field].postings.get(term) ?? []).map((posting) => posting.index)),
    )]));
    const scores = new Map<number, number>();
    const coveredTerms = new Map<number, Set<string>>();
    for (const field of ["text", "node", "section"] as const) {
      addFieldScores(index, field, queryTerms, alternatives, exactEntries, scores, undefined, coveredTerms);
    }
    // Page and derived cluster labels can help rank an original match, never create one.
    const matched = new Set(scores.keys());
    if (queryTerms.length === 1) {
      const exact = exactEntries.get(queryTerms[0]!)!;
      if (exact.size > 0 && exact.size < matched.size) {
        singleWordExactIds = new Set(Array.from(exact, (entry) => index.entries[entry]!.evidence.evidenceId));
      }
    }
    addFieldScores(index, "page", queryTerms, alternatives, exactEntries, scores, matched);
    addFieldScores(index, "cluster", queryTerms, alternatives, exactEntries, scores, matched);
    for (const [entry, score] of scores) {
      let coverage = 0;
      for (const term of coveredTerms.get(entry) ?? []) {
        coverage += exactEntries.get(term)!.has(entry) ? 1 : ALTERNATIVE_COVERAGE_WEIGHT;
      }
      scores.set(entry, score * (coverage / queryTerms.length) ** 2);
    }
    matches = contentFirst([...scores.entries()]
      .sort(([a, aScore], [b, bScore]) => bScore - aScore || a - b)
      .map(([entry]) => index.entries[entry]!), (entry) => entry.evidence, singleWordExactIds);
  } else {
    // A board overview covers different areas before spending its budget on another
    // paragraph from the same large cluster. Order remains stable for pagination.
    matches = contentFirst(interleaveClusters(index.entries), (entry) => entry.evidence);
  }

  if (!query && !options.includeNeighbors) matches = derivedLastInCluster(matches);
  const totalMatched = matches.length;
  const distinct = (entries: IndexedEvidence[]) => {
    const seen = new Set<string>();
    return entries.filter(({ evidence }) => {
      const key = evidence.text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const primary = (options.limit === undefined ? matches : distinct(matches).slice(0, options.limit))
    .map((entry) => entry.evidence);
  const selected = [...primary];
  if (options.includeNeighbors && selected.length > 0) {
    if (query) addTableNeighbors(index, selected, options.tableNeighborLimit ?? 6);
    addNeighbors(board, index, primary, selected, options.neighborLimit ?? 6);
  }
  // Only results with added neighbors need to rank metadata again.
  const evidence = options.includeNeighbors && !singleWordExactIds && !options.nodeIds
    ? contentFirst(selected, (item) => item) : selected;
  return {
    snapshotId: index.snapshotId,
    evidence,
    primaryEvidenceIds: primary.map((item) => item.evidenceId),
    connections: connectionsForEvidence(board, selected),
    totalMatched,
    ...(requestedCounts ? { requestedCounts } : {}),
  };
}

/**
 * Arrows of the displayed source nodes, at most 100. With ends "either", an end
 * that is not displayed is named by its short text; the board's redaction applies.
 */
export function connectionsForEvidence(board: BoardData, evidence: Evidence[], ends: ConnectionEnds = "both"): EvidenceConnection[] {
  const selected = displayedNodeIds(evidence);
  const endText = (nodeId: string) => {
    if (selected.has(nodeId)) return undefined;
    const node = boardLookups(board).nodesById.get(nodeId);
    const text = (node?.text?.trim() || node?.name.trim() || "").replace(/\s+/g, " ");
    return text ? boundedText(text, END_TEXT_CHARS) : undefined;
  };
  return matchingConnections(board, selected, ends)
    .slice(0, 100)
    .map((edge) => {
      const fromText = endText(edge.fromNodeId);
      const toText = endText(edge.toNodeId);
      return {
        connectorId: edge.connectorId,
        fromNodeId: edge.fromNodeId,
        ...(fromText ? { fromText } : {}),
        toNodeId: edge.toNodeId,
        ...(toText ? { toText } : {}),
        direction: edge.direction ?? "forward",
        label: edge.label ? boundedText(edge.label, 240) : undefined,
        url: nodeLink(board, edge.connectorId),
      };
    });
}

export function countConnectionsForEvidence(board: BoardData, evidence: Evidence[], ends: ConnectionEnds = "both"): number {
  return matchingConnections(board, displayedNodeIds(evidence), ends).length;
}

export function formatEvidenceConnection(connection: EvidenceConnection): string {
  const end = (nodeId: string, text?: string) => text ? `${nodeId} «${text}»` : nodeId;
  return `${end(connection.fromNodeId, connection.fromText)} ${connectorArrow(connection)} ${end(connection.toNodeId, connection.toText)}` +
    `${connection.label ? ` (${connection.label})` : ""}`;
}

function displayedNodeIds(evidence: Evidence[]): Set<string> {
  return new Set(evidence.flatMap((item) => [item.nodeId, ...(item.renderNodeId ? [item.renderNodeId] : [])]));
}

function matchingConnections(board: BoardData, selected: ReadonlySet<string>, ends: ConnectionEnds): ConnectorEdge[] {
  const edges = (board.connectorEdges ?? []).filter((edge) => edge.fromNodeId !== edge.toNodeId || edge.label?.trim());
  if (ends === "both") return edges.filter((edge) => selected.has(edge.fromNodeId) && selected.has(edge.toNodeId));
  if (!edges.length) return [];
  const { nodesById, enclosing } = boardLookups(board);
  const type = (id: string) => nodesById.get(id)?.type ?? "";
  const around = new Set<string>();
  for (const id of selected) for (const container of enclosing(id)) if (ENCLOSING_END_TYPES.has(type(container))) around.add(container);
  const onPage = (id: string) => selected.has(id) || around.has(id);
  return edges.filter((edge) => !PAGE_END_TYPES.has(type(edge.fromNodeId)) && !PAGE_END_TYPES.has(type(edge.toNodeId)) &&
    (onPage(edge.fromNodeId) || onPage(edge.toNodeId)));
}

// One lookup per published snapshot; a page is fitted to its budget with many calls.
const lookups = new WeakMap<BoardData, { nodesById: Map<string, NormalizedNode>; enclosing: (nodeId: string) => Set<string> }>();

function boardLookups(board: BoardData): { nodesById: Map<string, NormalizedNode>; enclosing: (nodeId: string) => Set<string> } {
  let found = lookups.get(board);
  if (!found) {
    found = { nodesById: new Map(board.nodes.map((node) => [node.id, node])), enclosing: enclosingIdsLookup(board) };
    lookups.set(board, found);
  }
  return found;
}

/** IDs of the nodes, table cells and excerpts of this snapshot. */
export function knownNodeIds(board: BoardData): Set<string> {
  const known = new Set(board.nodes.map((node) => node.id));
  for (const node of board.nodes) for (const id of node.hiddenDescendantIds ?? []) known.add(id);
  // Empty cells of skipped empty rows are in no row excerpt but exist.
  for (const node of board.nodes) for (const cell of node.table?.cells ?? []) known.add(cell.id);
  for (const { evidence, cellIds } of getIndex(board).entries) {
    known.add(evidence.nodeId);
    if (evidence.renderNodeId) known.add(evidence.renderNodeId);
    for (const id of cellIds ?? []) known.add(id);
  }
  return known;
}

/** Requested IDs that name no node, table cell or excerpt of this snapshot, in request order. */
export function unknownNodeIds(board: BoardData, nodeIds: string[]): string[] {
  const known = knownNodeIds(board);
  return [...new Set(nodeIds)].filter((id) => !known.has(id));
}

/** Requested IDs of pages, sections, frames and groups, in request order. */
export function readableContainerIds(board: BoardData, nodeIds: string[]): string[] {
  const types = new Map(board.nodes.map((node) => [node.id, node.type]));
  return [...new Set(nodeIds)].filter((id) => READABLE_CONTAINER_TYPES.has(types.get(id) ?? ""));
}

/**
 * IDs of the pages, sections, frames and groups enclosing a node, from its tree
 * path and its recorded page and sections. The node itself is not included.
 */
export function enclosingIdsLookup(board: Pick<BoardData, "nodes">): (nodeId: string) => Set<string> {
  const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
  const memo = new Map<string, Set<string>>();
  return (nodeId) => {
    const cached = memo.get(nodeId);
    if (cached) return cached;
    const node = nodesById.get(nodeId);
    const ids = new Set<string>([...(node?.sectionIds ?? []), ...(node?.pageId ? [node.pageId] : [])]);
    let parentId = node?.parentId;
    for (let depth = 0; parentId && depth < MAX_ENCLOSING_DEPTH; depth++) {
      ids.add(parentId);
      parentId = nodesById.get(parentId)?.parentId;
    }
    ids.delete(nodeId);
    memo.set(nodeId, ids);
    return ids;
  };
}

/** Whether an excerpt lies in a section, by its node or, for a table row or cell, by the table. */
export function inSectionLookup(board: BoardData): (item: Evidence) => boolean {
  const types = new Map(board.nodes.map((node) => [node.id, node.type]));
  const enclosing = enclosingIdsLookup(board);
  return (item) => [...enclosing(item.renderNodeId ?? item.nodeId)].some((id) => types.get(id) === "SECTION");
}

/**
 * Each excerpt belongs to one requested ID: its own cell, node or render ID if
 * requested, else the innermost requested container around it. Within an ID the
 * reading order stays; the IDs take turns with content in request order, one
 * excerpt per ID and round, consecutive rows of a table counting as one, so every
 * requested ID reaches every page. Name-only excerpts follow, ID by ID.
 */
function shareRequestedIds(
  board: BoardData, entries: IndexedEvidence[], requested: string[], containers: ReadonlySet<string>,
  enclosing: (nodeId: string) => Set<string>,
): { entries: IndexedEvidence[]; counts: Array<{ id: string; count: number }> } {
  const requestedSet = new Set(requested);
  const ordered = requested.filter((id) => containers.has(id));
  // A container inside another one in this request is the inner one.
  const depth = new Map(ordered.map((id) => [id, ordered.filter((other) => enclosing(id).has(other)).length]));
  const owned = new Map<string, IndexedEvidence[]>(requested.map((id) => [id, []]));
  for (const entry of entries) {
    const { evidence, cellIds } = entry;
    const own = [...(cellIds ?? []), evidence.nodeId, evidence.renderNodeId].find((id) => id !== undefined && requestedSet.has(id));
    const around = enclosing(evidence.renderNodeId ?? evidence.nodeId);
    const owner = own ?? ordered.filter((id) => around.has(id))
      .reduce((inner, id) => depth.get(id)! > depth.get(inner)! ? id : inner);
    owned.get(owner)!.push(entry);
  }
  const read = [...owned.values()].map((group) => readingOrder(board, group));
  const isName = (entry: IndexedEvidence) => entry.evidence.sourceType === "board_metadata";
  let active = read.map((group) => tableUnits(group.filter((entry) => !isName(entry)))).filter((units) => units.length);
  const shared: IndexedEvidence[] = [];
  for (let round = 0; active.length; round++) {
    for (const units of active) shared.push(...units[round]!);
    active = active.filter((units) => units.length > round + 1);
  }
  shared.push(...read.flatMap((group) => group.filter(isName)));
  return { entries: shared, counts: [...owned].map(([id, group]) => ({ id, count: group.length })) };
}

/** Single excerpts, except that consecutive rows of one table form one unit. */
function tableUnits(entries: IndexedEvidence[]): IndexedEvidence[][] {
  const units: IndexedEvidence[][] = [];
  for (const entry of entries) {
    const last = units.at(-1)?.[0]?.evidence;
    if (entry.evidence.sourceType === "table_row" && last?.sourceType === "table_row" && last.nodeId === entry.evidence.nodeId) {
      units.at(-1)!.push(entry);
    } else {
      units.push([entry]);
    }
  }
  return units;
}

/** Ranks for independent single-scope reads, grouped in one pass over the evidence index. */
export function scopeEvidenceRanks(board: BoardData, scopeIds: ReadonlySet<string>): Map<string, Map<string, number>> {
  if (!scopeIds.size) return new Map();
  const groups = new Map<string, IndexedEvidence[]>([...scopeIds].map((id) => [id, []]));
  const containers = new Set(readableContainerIds(board, [...scopeIds]));
  const { enclosing } = boardLookups(board);
  const readInOrder = createReadingOrder(board);
  for (const entry of getIndex(board).entries) {
    const { evidence, cellIds } = entry;
    const add = (id: string) => {
      const group = groups.get(id);
      if (group && group.at(-1) !== entry) group.push(entry);
    };
    add(evidence.nodeId);
    if (evidence.renderNodeId) add(evidence.renderNodeId);
    for (const id of cellIds ?? []) add(id);
    for (const id of enclosing(evidence.renderNodeId ?? evidence.nodeId)) {
      if (containers.has(id)) add(id);
    }
  }
  // Sort each scope independently. Removing nodes from a page-wide sort can
  // change which items overlap in a row band or break ties in cluster order.
  return new Map([...groups].map(([id, group]) => {
    const ordered = containers.has(id) ? contentFirst(readInOrder(group), (entry) => entry.evidence) : group;
    return [id, new Map(derivedLastInCluster(ordered).map(({ evidence }, index) => [evidence.evidenceId, index]))];
  }));
}

/** Read groups and their source nodes by position; a node's rows and chunks keep their index order. */
function readingOrder(board: BoardData, entries: IndexedEvidence[]): IndexedEvidence[] {
  if (entries.length < 2) return entries;
  return createReadingOrder(board)(entries);
}

function createReadingOrder(board: BoardData): (entries: IndexedEvidence[]) => IndexedEvidence[] {
  const clustersById = new Map(board.clusters.map((cluster) => [cluster.id, cluster]));
  const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
  const pages = pagePositions(board.nodes);
  return (entries) => inClusterReadingOrder(entries, ({ evidence }) => {
    const nodeId = evidence.renderNodeId ?? evidence.nodeId;
    return {
      nodeId, bounds: nodesById.get(nodeId) ?? nodesById.get(evidence.nodeId),
      page: pages.get(evidence.pageId ?? "") ?? -1,
      cluster: evidence.clusterId ? clustersById.get(evidence.clusterId) : undefined,
    };
  });
}

/**
 * Names without text (frames, links, shapes) rank high on short BM25 fields and
 * would crowd out board text; they follow content within each match tier.
 */
function contentFirst<T>(items: T[], evidenceOf: (item: T) => Evidence, exactIds?: ReadonlySet<string>): T[] {
  if (exactIds?.size) {
    const exact = (item: T) => exactIds.has(evidenceOf(item).evidenceId);
    // Even a rare alternative in body text must follow an exact single-word match in metadata.
    return [...contentFirst(items.filter(exact), evidenceOf), ...contentFirst(items.filter((item) => !exact(item)), evidenceOf)];
  }
  const isMetadata = (item: T) => evidenceOf(item).sourceType === "board_metadata";
  return [...items.filter((item) => !isMetadata(item)), ...items.filter(isMetadata)];
}

/** Place derived excerpts after their cluster's last original content excerpt. */
function derivedLastInCluster(entries: IndexedEvidence[]): IndexedEvidence[] {
  if (!entries.some(({ evidence }) => evidence.modelDerived)) return entries;
  const lastOriginal = new Map<string, IndexedEvidence>();
  for (const entry of entries) {
    const { evidence } = entry;
    if (!evidence.modelDerived && evidence.sourceType !== "board_metadata" && evidence.clusterId !== undefined) {
      lastOriginal.set(evidence.clusterId, entry);
    }
  }
  const derivedByOriginal = new Map<IndexedEvidence, IndexedEvidence[]>();
  const ordered = entries.filter((entry) => {
    const { clusterId, modelDerived } = entry.evidence;
    const end = modelDerived && clusterId !== undefined ? lastOriginal.get(clusterId) : undefined;
    if (end === undefined) return true;
    const derived = derivedByOriginal.get(end);
    if (derived) derived.push(entry);
    else derivedByOriginal.set(end, [entry]);
    return false;
  });
  if (!derivedByOriginal.size) return entries;
  return ordered.flatMap((entry) => {
    const derived = derivedByOriginal.get(entry);
    return derived ? [entry, ...derived] : [entry];
  });
}

/** One excerpt per cluster and round; consecutive rows of one table count as one excerpt. */
function interleaveClusters(entries: IndexedEvidence[]): IndexedEvidence[] {
  const groups = new Map<string, IndexedEvidence[]>();
  for (const entry of entries) {
    const key = entry.evidence.clusterId ?? entry.evidence.nodeId;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const ordered: IndexedEvidence[] = [];
  let active = [...groups.values()].map(tableUnits);
  for (let offset = 0; active.length; offset++) {
    const next: IndexedEvidence[][][] = [];
    for (const group of active) {
      ordered.push(...group[offset]!);
      if (group.length > offset + 1) next.push(group);
    }
    active = next;
  }
  return ordered;
}

/** Whether a derived excerpt is text the server generated without a model (a cluster that no model interpreted). */
export const isGeneratedPlaceholder = (item: Pick<Evidence, "sourceType">): boolean => item.sourceType === "cluster_summary";

/** Where an excerpt comes from: original board text or metadata, a table row, a model interpretation or a generated placeholder. */
export function evidenceProvenance(item: Evidence): string {
  return isGeneratedPlaceholder(item) ? "GENERATED PLACEHOLDER, no model; verify against original" :
    item.modelDerived ? "MODEL INTERPRETATION; verify against original" :
    item.sourceType === "board_metadata" ? "original board metadata" :
    item.sourceType === "table_row" ? `original table row; cells separated by "${TABLE_CELL_SEPARATOR.trim()}"` : "original board text";
}

const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** The cluster label of a derived excerpt and the metadata of its source, one line each, before the excerpt text. */
export function evidenceDetailLines(item: Evidence): string {
  const metadata = [
    item.nodeName ? `Node name: ${singleLine(item.nodeName)}` : undefined,
    item.pageName ? `Page: ${singleLine(item.pageName)}` : undefined,
    item.sectionNames?.length ? `Sections: ${item.sectionNames.map(singleLine).join(" / ")}` : undefined,
    item.frameNames?.length ? `Frames: ${item.frameNames.map(singleLine).join(" / ")}` : undefined,
    item.sourceType === "table_cell" && item.renderNodeId ? `Table node: ${item.renderNodeId}` : undefined,
    item.row !== undefined ? `Row index: ${item.row}` : undefined,
    item.column !== undefined ? `Column index: ${item.column}` : undefined,
  ].filter(Boolean).join("; ");
  const derivedLabel = (item.sourceType === "model_interpretation" || item.sourceType === "cluster_summary") && item.clusterLabel
    ? `Cluster label${item.clusterLabelModel ? " (model)" : ""}: ${singleLine(item.clusterLabel)}\n` : "";
  return `${derivedLabel}${metadata ? `Original source metadata: ${metadata}\n` : ""}`;
}

export function formatEvidence(item: Evidence): string {
  return `[${item.evidenceId}] ${singleLine(item.nodeName ?? item.nodeId)} (${evidenceProvenance(item)}; node ${item.nodeId})\n${evidenceDetailLines(item)}${item.text}`;
}

export function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";
  let end = maxChars - 1;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
  return `${value.slice(0, end)}…`;
}

function addFieldScores(
  index: EvidenceIndex, field: EvidenceField, queryTerms: string[], expansions: Map<string, string[]>, exactEntries: Map<string, Set<number>>, scores: Map<number, number>,
  allowed?: Set<number>,
  coveredTerms?: Map<number, Set<string>>,
): void {
  const fieldIndex = index.fields[field];
  for (const term of queryTerms) {
    const alternatives = [{ term, weight: 1 }, ...(expansions.get(term) ?? [])
      .map((word) => ({ term: word, weight: PREFIX_MATCH_WEIGHT }))];
    // A query word contributes once per field/chunk; several matching compounds
    // must not turn a partial match into an unbounded frequency bonus.
    const termScores = new Map<number, number>();
    for (const alternative of alternatives) {
      const postings = fieldIndex.postings.get(alternative.term) ?? [];
      const idf = Math.log(1 + (index.entries.length - postings.length + 0.5) / (postings.length + 0.5));
      for (const posting of postings) {
        if (allowed && !allowed.has(posting.index)) continue;
        const length = index.entries[posting.index]!.lengths[field];
        const normalization = 1.2 * (0.5 + 0.5 * length / fieldIndex.averageLength);
        const score = alternative.weight * FIELD_WEIGHTS[field] * idf * posting.frequency * 2.2 /
          (posting.frequency + normalization);
        if (alternative.weight === 1 || !exactEntries.get(term)?.has(posting.index)) {
          termScores.set(posting.index, Math.max(termScores.get(posting.index) ?? 0, score));
        }
      }
    }
    for (const [entry, score] of termScores) {
      scores.set(entry, (scores.get(entry) ?? 0) + score);
      if (coveredTerms) {
        const terms = coveredTerms.get(entry) ?? new Set<string>();
        terms.add(term);
        coveredTerms.set(entry, terms);
      }
    }
  }
}

// Alternatives help with recall, but rare forms should not outweigh coverage by exact terms.
const ALTERNATIVE_COVERAGE_WEIGHT = 0.3;
const WORD_ENDINGS = ["e", "n", "s", "en", "er", "es", "em", "ern", "nen", "ed", "ing"];
const latinWord = (word: string) => /^[\p{Script=Latin}\p{M}]+$/u.test(word);
const reverseWord = (word: string) => [...word].reverse().join("");

function wordAlternatives(index: EvidenceIndex, term: string): string[] {
  if (term.length < 5 || !latinWord(term)) return [];
  const vocabulary = index.vocabularySet;
  const words = new Set(compoundPrefixes(index.vocabulary, term));
  const bases = [term, ...WORD_ENDINGS.filter((ending) => term.endsWith(ending) && term.length - ending.length >= 4)
    .map((ending) => term.slice(0, -ending.length))];
  for (const base of bases) {
    if (vocabulary.has(base)) words.add(base);
    for (const ending of WORD_ENDINGS) if (vocabulary.has(base + ending)) words.add(base + ending);
  }
  for (const reversed of compoundPrefixes(index.reversedVocabulary, reverseWord(term))) words.add(reverseWord(reversed));
  words.delete(term);
  return [...words];
}

const MIN_SUGGESTION_SIMILARITY = 0.5;
const MAX_SUGGESTION_WORD_LENGTH = 80;
const GENERIC_NAME_WORDS = new Set([...GENERIC_NODE_NAMES].flatMap(name => [
  ...evidenceTokens(name), ...evidenceTokens(name.replaceAll(" ", "-")),
]));

/** One insertion, deletion or adjacent transposition in a short word, or one substitution in a word of at least six letters. */
function isShortTypo(term: string, word: string, prefix: number): boolean {
  const shorter = term.length <= word.length ? term : word;
  const longer = shorter === term ? word : term;
  if (shorter.length < 4 || longer.length > 8 || longer.length - shorter.length > 1 || term === word) return false;
  if (shorter.length !== longer.length) return shorter.slice(prefix) === longer.slice(prefix + 1);
  // One changed letter in a shorter word mostly gives another valid word ("gold", "cold").
  if (shorter.slice(prefix + 1) === longer.slice(prefix + 1)) return shorter.length >= 6;
  return shorter[prefix] === longer[prefix + 1] && shorter[prefix + 1] === longer[prefix]
    && shorter.slice(prefix + 2) === longer.slice(prefix + 2);
}

/** Suggestions are board data, not matches. Call with a redacted board. */
export function similarBoardWords(board: BoardData, query: string): string[] {
  const terms = [...new Set(evidenceTokens(query))].filter((term) => term.length >= 3 && term.length <= MAX_SUGGESTION_WORD_LENGTH && latinWord(term));
  if (!terms.length) return [];
  const trigrams = (word: string) => new Set(Array.from({ length: Math.max(0, word.length - 2) }, (_, i) => word.slice(i, i + 3)));
  const queryGrams = terms.map(trigrams);
  const index = getIndex(board);
  let authoredWords: Set<string> | undefined;
  return index.vocabulary.flatMap((word) => {
    if (word.length < 3 || word.length > MAX_SUGGESTION_WORD_LENGTH || !latinWord(word)) return [];
    const grams = trigrams(word);
    let best = 0;
    let typo = 0;
    terms.forEach((term, i) => {
      let prefix = 0;
      while (prefix < Math.min(term.length, word.length) && term[prefix] === word[prefix]) prefix++;
      if (isShortTypo(term, word, prefix)) typo = Math.max(typo, 1 - 1 / Math.max(term.length, word.length));
      const shared = [...queryGrams[i]!].filter((gram) => grams.has(gram)).length;
      const score = Math.max(prefix >= 3 ? prefix / Math.max(term.length, word.length) : 0,
        shared >= 2 ? 2 * shared / (queryGrams[i]!.size + grams.size) : 0);
      best = Math.max(best, score);
    });
    // A word that shares a prefix or trigrams with the query ranks before one that is only a single edit away.
    const strong = best > MIN_SUGGESTION_SIMILARITY;
    if (!strong && !typo) return [];
    if (GENERIC_NAME_WORDS.has(word)) {
      authoredWords ??= new Set(board.nodes.filter(node => node.hiddenDescendantIds === undefined).flatMap(node => [
        ...evidenceTokens(node.text ?? ""),
        ...((node.table?.cells ?? []).flatMap(cell => evidenceTokens(cell.text))),
        ...(isGenericNodeName(node.name, { includeVariants: true }) ? [] : evidenceTokens(node.name)),
      ]));
      if (!authoredWords.has(word)) return [];
    }
    return [{ word, score: Math.max(best, typo), strong }];
  }).sort((a, b) => Number(b.strong) - Number(a.strong) || b.score - a.score || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
    .slice(0, 8).map(({ word }) => word);
}

function compoundPrefixes(vocabulary: string[], term: string): string[] {
  // This is a bounded lexical aid for compounds, not substring or fuzzy search.
  // Short acronyms, numbers, and non-Latin segmentation retain exact matching.
  if (term.length < 5 || !/^[\p{Script=Latin}\p{M}]+$/u.test(term)) return [];
  let low = 0;
  let high = vocabulary.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (vocabulary[middle]! < term) low = middle + 1;
    else high = middle;
  }
  const expanded: string[] = [];
  for (let position = low; position < vocabulary.length && expanded.length < MAX_PREFIX_TERMS; position++) {
    const word = vocabulary[position]!;
    if (!word.startsWith(term)) break;
    if (word.length >= term.length + 3 && /^[\p{Script=Latin}\p{M}]+$/u.test(word)) expanded.push(word);
  }
  return expanded;
}

function getIndex(board: BoardData): EvidenceIndex {
  const existing = indexes.get(board);
  if (existing) return existing;
  const snapshotId = snapshotIdForBoard(board);
  const sources = buildEvidence(board, snapshotId);
  const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
  const emptyField = (): FieldIndex => ({ postings: new Map(), averageLength: 1 });
  const fields: Record<EvidenceField, FieldIndex> = {
    text: emptyField(), node: emptyField(), section: emptyField(), page: emptyField(), cluster: emptyField(),
  };
  const firstRows = new Map<string, Evidence[]>();
  for (const { evidence: item } of sources) {
    if (item.sourceType !== "table_row") continue;
    const rows = firstRows.get(item.nodeId);
    if (!rows) firstRows.set(item.nodeId, [item]);
    else if (rows[0]!.row === item.row) rows.push(item);
  }
  const labels = new Map<string, string[]>();
  const cellTables = new Map<string, string>();
  for (const node of board.nodes) for (const cell of node.table?.cells ?? []) cellTables.set(cell.id, node.id);
  for (const edge of board.connectorEdges ?? []) {
    if (!edge.label?.trim()) continue;
    for (const id of new Set([edge.fromNodeId, edge.toNodeId].map((end) => cellTables.get(end) ?? end))) {
      const existingLabels = labels.get(id) ?? [];
      existingLabels.push(edge.label);
      labels.set(id, existingLabels);
    }
  }
  const headings = new Map([...firstRows].map(([id, rows]) => [id, rows.map((row) => row.text).join("\n")]));
  const totalLengths: Record<EvidenceField, number> = { text: 0, node: 0, section: 0, page: 0, cluster: 0 };
  const entries: IndexedEvidence[] = [];
  const tokenizedWords = new Map<string, TokenizedWord>();
  for (const { evidence: item, cellIds } of sources) {
    if (isGeneratedPlaceholder(item)) {
      entries.push({ evidence: item, lengths: { text: 0, node: 0, section: 0, page: 0, cluster: 0 } });
      continue;
    }
    const node = nodesById.get(item.renderNodeId ?? item.nodeId);
    const firstRow = firstRows.get(item.nodeId)?.[0]?.row;
    const isLaterRow = item.sourceType === "table_row" && item.row !== firstRow;
    const extraNode = [isLaterRow ? headings.get(item.nodeId) : "",
      !isLaterRow && item.sourceType !== "table_cell" ? (labels.get(node?.id ?? item.nodeId) ?? []).join("\n") : ""].filter(Boolean).join("\n");
    const values = evidenceFields(item, node, nodesById, extraNode);
    const lengths = {} as Record<EvidenceField, number>;
    const position = entries.length;
    for (const field of FIELDS) {
      const tokens = tokenizeEvidence(values[field], tokenizedWords);
      lengths[field] = tokens.length;
      totalLengths[field] += tokens.length;
      const frequencies = new Map<string, number>();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      for (const [term, frequency] of frequencies) {
        const list = fields[field].postings.get(term) ?? [];
        list.push({ index: position, frequency });
        fields[field].postings.set(term, list);
      }
    }
    entries.push({ evidence: item, ...(cellIds ? { cellIds } : {}), lengths });
  }
  for (const field of FIELDS) {
    fields[field].averageLength = totalLengths[field] / Math.max(1, entries.length) || 1;
  }
  const vocabulary = [...new Set(ORIGINAL_FIELDS.flatMap((field) => [...fields[field].postings.keys()]))].sort();
  const reversedVocabulary = vocabulary.filter(latinWord).map(reverseWord).sort();
  const index = { snapshotId, entries, fields, vocabulary, vocabularySet: new Set(vocabulary), reversedVocabulary, firstRows };
  indexes.set(board, index);
  return index;
}

function evidenceFields(
  item: Evidence, node: NormalizedNode | undefined, nodesById: Map<string, NormalizedNode>, extraNode: string,
): Record<EvidenceField, string> {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const name = normalize(node?.name ?? "");
  const text = normalize(node?.text ?? "");
  // Figma frequently derives the node name from its full text or its opening.
  // Indexing that name on every chunk leaks a match into unrelated trailing text.
  const nameDuplicatesText = Boolean(name && text && text.startsWith(name));
  return {
    text: item.text,
    node: [item.sourceType === "board_metadata" || nameDuplicatesText ? "" : node?.name, node?.type, extraNode]
      .filter(Boolean).join("\n"),
    section: [...(node?.sectionIds ?? []).map((id) => nodesById.get(id)?.name ?? ""), ...(item.frameNames ?? [])].join("\n"),
    page: node?.pageId ? nodesById.get(node.pageId)?.name ?? "" : "",
    cluster: item.clusterLabel ?? "",
  };
}

function buildEvidence(board: BoardData, snapshotId: string): EvidenceSource[] {
  const clusterOf = new Map<string, RefinedCluster>();
  for (const cluster of board.clusters) {
    for (const nodeId of cluster.nodeIds) if (!clusterOf.has(nodeId)) clusterOf.set(nodeId, cluster);
  }
  const evidence: EvidenceSource[] = [];
  const append = (
    text: string,
    source: Pick<Evidence, "nodeId" | "sourceType" | "modelDerived"> & Partial<Evidence>,
    cluster?: RefinedCluster,
    cellIds?: string[],
  ) => {
    const chunks = chunkText(text);
    // Rows of one table share its node ID; equal rows still get distinct IDs.
    const rowKey = source.sourceType === "table_row" ? `\0${source.row}` : "";
    for (const [chunkIndex, chunk] of chunks.entries()) {
      if (evidence.length >= MAX_INDEX_ENTRIES) {
        throw new Error(`Board exceeds the ${MAX_INDEX_ENTRIES}-chunk evidence limit. Ingest a smaller board or page.`);
      }
      evidence.push({ evidence: {
        ...source,
        evidenceId: `ev_${digest(`${snapshotId}\0${source.sourceType}\0${source.nodeId}\0${source.modelDerived ? cluster?.id ?? "" : ""}\0${chunkIndex}\0${chunk}${rowKey}`).slice(0, 32)}`,
        snapshotId,
        nodeId: source.nodeId,
        text: chunk,
        clusterId: cluster?.id,
        clusterLabel: cluster ? boundedText(cluster.label, 160) : undefined,
        clusterLabelModel: cluster ? isModelLabel(cluster) : undefined,
        chunkIndex,
        url: nodeLink(board, source.renderNodeId ?? source.nodeId),
        truncated: chunks.length > 1,
      }, ...(cellIds ? { cellIds } : {}) });
    }
  };
  const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
  for (const node of board.nodes) {
    if (node.hiddenDescendantIds !== undefined) continue;
    const cluster = clusterOf.get(node.id);
    const provenance = nodeProvenance(node, nodesById);
    const rows = node.table?.cells.length ? tableRows(node) : undefined;
    if (rows) {
      for (const { row, cells } of rows) {
        if (!cells.some((cell) => cell.text.trim())) continue;
        append(cells.map((cell) => cell.text.replace(/\s+/g, " ").trim()).join(TABLE_CELL_SEPARATOR), {
          ...provenance,
          nodeId: node.id,
          renderNodeId: node.renderNodeId ?? node.id,
          sourceType: "table_row",
          modelDerived: false,
          row,
        }, cluster, cells.map((cell) => cell.id));
      }
    } else if (node.table?.cells.length) {
      for (const cell of node.table.cells) {
        append(cell.text, {
          ...provenance,
          nodeId: cell.id,
          renderNodeId: node.renderNodeId ?? node.id,
          sourceType: "table_cell",
          modelDerived: false,
          row: cell.row,
          column: cell.column,
        }, cluster);
      }
    } else if (node.text?.trim() && node.type !== "CONNECTOR") {
      // An arrow's text is its label in connections, relations and diffs, not an excerpt.
      append(node.text, { ...provenance, nodeId: node.id, sourceType: "board_text", modelDerived: false }, cluster);
    }
    if (!node.text?.trim() && !node.table?.cells.some((cell) => cell.text.trim()) && node.name.trim() &&
      !CONTAINER_TYPES.has(node.type) && !isGenericNodeName(node.name) &&
      !(node.imageRef && isImageFileName(node.name))) {
      append(node.name, { ...provenance, nodeId: node.id, sourceType: "board_metadata", modelDerived: false }, cluster);
    }
  }
  for (const cluster of board.clusters) {
    const modelDerived = isModelLabel(cluster);
    const hasOriginalText = cluster.nodeIds.some((id) => {
      const node = nodesById.get(id);
      return Boolean(node?.text?.trim() || node?.table?.cells.some((cell) => cell.text.trim()));
    });
    if (!modelDerived && hasOriginalText) continue;
    const nodeId = cluster.nodeIds.find((id) => nodesById.get(id)?.imageRef) ?? cluster.nodeIds[0];
    if (!nodeId) continue;
    append(cluster.summary, {
      ...nodeProvenance(nodesById.get(nodeId), nodesById),
      nodeId,
      sourceType: modelDerived ? "model_interpretation" : "cluster_summary",
      // A legacy/deterministic summary is not a verbatim source either.
      modelDerived: true,
    }, cluster);
  }
  // Only keep a frame or group name as an excerpt when nothing inside it produced one.
  const containersWithEvidence = new Set<string>();
  for (const { evidence: item } of evidence) {
    let parentId = nodesById.get(item.renderNodeId ?? item.nodeId)?.parentId;
    for (let depth = 0; parentId && depth < MAX_ENCLOSING_DEPTH; depth++) {
      const parent = nodesById.get(parentId);
      if (!parent) break;
      if (parent.type === "FRAME" || parent.type === "GROUP") containersWithEvidence.add(parent.id);
      parentId = parent.parentId;
    }
  }
  return evidence.filter(({ evidence: item }) => item.sourceType !== "board_metadata" || !containersWithEvidence.has(item.nodeId));
}

function isModelLabel(cluster: RefinedCluster): boolean {
  return cluster.summarySource === "vision_llm" || cluster.summarySource === "text_llm" || Boolean(cluster.modelId);
}

function isImageFileName(name: string): boolean {
  const value = name.trim();
  return /\.(?:png|jpe?g|gif|webp|heic|heif|svg|bmp|tiff?|pdf)$/i.test(value) ||
    /^(?:screenshot|screen shot|bildschirmfoto|capture d[’']écran|img[_ -]\d|image \d+|bild \d+)/i.test(value);
}

/** Rows in order with their cells in column order, or undefined if any cell has no row. */
export function tableRows(table: NormalizedNode): Array<{ row: number; cells: TableCell[] }> | undefined {
  const cells = tableCellPositions(table);
  if (!cells.length || cells.some((cell) => cell.row === undefined)) return undefined;
  const rows = new Map<number, TableCell[]>();
  for (const cell of cells) rows.set(cell.row!, [...(rows.get(cell.row!) ?? []), cell]);
  return [...rows].sort(([a], [b]) => a - b).map(([row, rowCells]) => ({
    row,
    // Cells without a column keep their snapshot order behind the positioned ones.
    cells: rowCells.sort((a, b) => (a.column ?? Infinity) - (b.column ?? Infinity) || 0),
  }));
}

function nodeProvenance(node: NormalizedNode | undefined, nodesById: Map<string, NormalizedNode>):
  Pick<Evidence, "pageId" | "sectionIds" | "renderNodeId" | "nodeName" | "pageName" | "sectionNames" | "frameNames"> {
  const sectionIds = node?.sectionIds?.slice(-16);
  const pageName = node?.pageId ? nodesById.get(node.pageId)?.name : undefined;
  const frames: string[] = [];
  let parentId = node?.parentId;
  for (let depth = 0; parentId && depth < MAX_ENCLOSING_DEPTH; depth++) {
    const parent = nodesById.get(parentId);
    if (!parent) break;
    if ((parent.type === "FRAME" || parent.type === "GROUP") && parent.name.trim() && !isGenericNodeName(parent.name)) {
      frames.push(boundedText(parent.name, 80));
    }
    parentId = parent.parentId;
  }
  const frameNames = frames.slice(0, 16).reverse();
  return {
    pageId: node?.pageId,
    sectionIds,
    renderNodeId: node?.renderNodeId,
    nodeName: node?.name ? boundedText(node.name, 160) : undefined,
    pageName: pageName ? boundedText(pageName, 160) : undefined,
    sectionNames: sectionIds?.map((id) => nodesById.get(id)?.name)
      .filter((name): name is string => Boolean(name)).map((name) => boundedText(name, 80)),
    ...(frameNames.length ? { frameNames } : {}),
  };
}

function chunkText(text: string): string[] {
  const value = text.trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + EVIDENCE_CHUNK_CHARS);
    if (end < value.length) {
      const whitespace = Math.max(value.lastIndexOf(" ", end), value.lastIndexOf("\n", end));
      if (whitespace > start + EVIDENCE_CHUNK_CHARS / 2) end = whitespace;
      if (/[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
    }
    const chunk = value.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

/** A matching cell needs nearby labels/values to retain its table meaning. */
function addTableNeighbors(index: EvidenceIndex, selected: Evidence[], limit: number): void {
  if (limit <= 0) return;
  let added = addHeaderRows(index, selected, limit);
  const rowGroups = new Map<string, Evidence[]>();
  const unpositionedTables = new Set<string>();
  const rowKey = (tableId: string, row: number) => `${tableId}\0${row}`;
  for (const item of selected) {
    if (item.sourceType !== "table_cell" || !item.renderNodeId) continue;
    if (item.row === undefined) unpositionedTables.add(item.renderNodeId);
    else rowGroups.set(rowKey(item.renderNodeId, item.row), []);
  }
  const existing = new Set(selected.map((item) => item.evidenceId));
  const wholeTables = new Map<string, Evidence[]>();
  for (const { evidence: item } of index.entries) {
    if (item.sourceType !== "table_cell" || !item.renderNodeId || existing.has(item.evidenceId)) continue;
    if (item.row !== undefined) rowGroups.get(rowKey(item.renderNodeId, item.row))?.push(item);
    if (unpositionedTables.has(item.renderNodeId)) {
      const group = wholeTables.get(item.renderNodeId) ?? [];
      group.push(item);
      wholeTables.set(item.renderNodeId, group);
    }
  }
  let active = [...rowGroups.values()].filter((group) => group.length > 0);
  for (let offset = 0; active.length && added < limit; offset++) {
    const next: Evidence[][] = [];
    for (const group of active) {
      if (added >= limit) break;
      const item = group[offset]!;
      selected.push(item);
      existing.add(item.evidenceId);
      added++;
      if (group.length > offset + 1) next.push(group);
    }
    active = next;
  }
  // Without recorded rows there is no justified "nearby" prefix. Keep a small
  // table only when its complete remaining context fits; otherwise add none.
  for (const group of wholeTables.values()) {
    const missing = group.filter((item) => !existing.has(item.evidenceId));
    if (missing.length > limit - added) continue;
    selected.push(...missing);
    for (const item of missing) existing.add(item.evidenceId);
    added += missing.length;
  }
}

/**
 * A matching row of a table without its first row lacks the column headings:
 * the first row is inserted before the table's first selected row. Returns how
 * many excerpts were added.
 */
function addHeaderRows(index: EvidenceIndex, selected: Evidence[], limit: number): number {
  const tables = new Set(selected.filter((item) => item.sourceType === "table_row").map((item) => item.nodeId));
  const existing = new Set(selected.map((item) => item.evidenceId));
  let added = 0;
  for (const tableId of tables) {
    const missing = (index.firstRows.get(tableId) ?? []).filter((item) => !existing.has(item.evidenceId)).slice(0, limit - added);
    if (!missing.length) continue;
    selected.splice(selected.findIndex((item) => item.sourceType === "table_row" && item.nodeId === tableId), 0, ...missing);
    for (const item of missing) existing.add(item.evidenceId);
    added += missing.length;
  }
  return added;
}

function addNeighbors(
  board: BoardData, index: EvidenceIndex, primary: Evidence[], selected: Evidence[], limit: number,
): void {
  const primaryNodes = new Set(primary.flatMap((item) => [item.nodeId, ...(item.renderNodeId ? [item.renderNodeId] : [])]));
  const neighborIds = new Set<string>();
  for (const edge of board.connectorEdges ?? []) {
    if (primaryNodes.has(edge.fromNodeId)) neighborIds.add(edge.toNodeId);
    if (primaryNodes.has(edge.toNodeId)) neighborIds.add(edge.fromNodeId);
  }
  const existing = new Set(selected.map((item) => item.evidenceId));
  const groups = new Map<string, { items: Evidence[]; wholeTable: boolean }>();
  for (const { evidence: item } of index.entries) {
    const wholeTable = (item.sourceType === "table_cell" || item.sourceType === "table_row") &&
      Boolean(item.renderNodeId && neighborIds.has(item.renderNodeId));
    if (existing.has(item.evidenceId) || !(neighborIds.has(item.nodeId) || wholeTable ||
      Boolean(item.renderNodeId && neighborIds.has(item.renderNodeId)))) continue;
    const key = item.renderNodeId ?? item.nodeId;
    const group = groups.get(key) ?? { items: [], wholeTable };
    group.items.push(item);
    group.wholeTable ||= wholeTable;
    groups.set(key, group);
  }
  let added = 0;
  let active = [...groups.values()];
  // Each ordinary neighbor gets one excerpt before a long neighbor gets another.
  // A directly connected table without a selected row is atomic, never a prefix.
  for (let offset = 0; active.length && added < limit; offset++) {
    const next: typeof active = [];
    for (const group of active) {
      if (added >= limit) break;
      if (group.wholeTable) {
        if (group.items.length <= limit - added) {
          selected.push(...group.items);
          added += group.items.length;
        }
      } else {
        selected.push(group.items[offset]!);
        added++;
        if (group.items.length > offset + 1) next.push(group);
      }
    }
    active = next;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
