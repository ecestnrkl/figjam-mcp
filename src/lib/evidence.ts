import { createHash } from "node:crypto";
import { connectorArrow } from "./connectorGraph.js";
import { isGenericNodeName } from "./nodeTree.js";
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

/** Original board text and model interpretations remain distinguishable at every boundary. */
export interface Evidence {
  evidenceId: string;
  snapshotId: string;
  nodeId: string;
  text: string;
  sourceType: "board_text" | "table_cell" | "table_row" | "board_metadata" | "model_interpretation" | "cluster_summary";
  modelDerived: boolean;
  clusterId?: string;
  clusterLabel?: string;
  nodeName?: string;
  pageName?: string;
  sectionNames?: string[];
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
  toNodeId: string;
  direction: NonNullable<ConnectorEdge["direction"]>;
  label?: string;
  url: string;
}

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
  "which", "who", "why", "with", "you", "your", "about", "board", "project", "please", "find",
  "aber", "als", "am", "an", "auch", "auf", "aus", "bei", "das", "dem", "den", "der", "des",
  "die", "ein", "eine", "einen", "einer", "es", "für", "hat", "haben", "im", "ist", "mit",
  "nach", "nicht", "oder", "sich", "sie", "sind", "über", "um", "und", "vom", "von", "war",
  "welche", "welcher", "welches", "wer", "wie", "wo", "zu", "zum", "zur", "projekt", "bitte",
  "dass", "laut", "bereits",
]);

/** Unicode word segmentation supports accented words and scripts without whitespace. */
export function evidenceTokens(text: string): string[] {
  return Array.from(segmenter.segment(text.normalize("NFKC").toLowerCase()))
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
    .filter((word) => !STOPWORDS.has(word));
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

/** Deterministic field-weighted BM25 over original chunks and source metadata. */
export function retrieveEvidence(board: BoardData, options: EvidenceQuery = {}): EvidenceResult {
  const index = getIndex(board);
  let matches: IndexedEvidence[];
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
  } else if (options.query?.trim()) {
    const queryTerms = [...new Set(evidenceTokens(options.query))];
    const scores = new Map<number, number>();
    for (const field of ORIGINAL_FIELDS) addFieldScores(index, field, queryTerms, scores);
    // Derived cluster labels can help rank an original match, never create one.
    addFieldScores(index, "cluster", queryTerms, scores, new Set(scores.keys()));
    matches = contentFirst([...scores.entries()]
      .sort(([a, aScore], [b, bScore]) => bScore - aScore || a - b)
      .map(([entry]) => index.entries[entry]!), (entry) => entry.evidence);
  } else {
    // A board overview covers different areas before spending its budget on another
    // paragraph from the same large cluster. Order remains stable for pagination.
    matches = contentFirst(interleaveClusters(index.entries), (entry) => entry.evidence);
  }

  const totalMatched = matches.length;
  const primary = (options.limit === undefined ? matches : matches.slice(0, options.limit))
    .map((entry) => entry.evidence);
  const selected = [...primary];
  if (options.includeNeighbors && selected.length > 0) {
    if (options.query?.trim()) addTableNeighbors(index, selected, options.tableNeighborLimit ?? 6);
    addNeighbors(board, index, primary, selected, options.neighborLimit ?? 6);
  }
  return {
    snapshotId: index.snapshotId,
    evidence: options.nodeIds ? selected : contentFirst(selected, (item) => item),
    primaryEvidenceIds: primary.map((item) => item.evidenceId),
    connections: connectionsForEvidence(board, selected),
    totalMatched,
    ...(requestedCounts ? { requestedCounts } : {}),
  };
}

/** Only connections between displayed source nodes are evidence for the current response. */
export function connectionsForEvidence(board: BoardData, evidence: Evidence[]): EvidenceConnection[] {
  return matchingConnections(board, evidence)
    .slice(0, 100)
    .map((edge) => ({
      connectorId: edge.connectorId,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      direction: edge.direction ?? "forward",
      label: edge.label ? boundedText(edge.label, 240) : undefined,
      url: nodeLink(board, edge.connectorId),
    }));
}

export function countConnectionsForEvidence(board: BoardData, evidence: Evidence[]): number {
  return matchingConnections(board, evidence).length;
}

export function formatEvidenceConnection(connection: EvidenceConnection): string {
  return `${connection.fromNodeId} ${connectorArrow(connection)} ${connection.toNodeId}${connection.label ? ` (${connection.label})` : ""}`;
}

function matchingConnections(board: BoardData, evidence: Evidence[]): ConnectorEdge[] {
  const selected = new Set(evidence.flatMap((item) => [item.nodeId, ...(item.renderNodeId ? [item.renderNodeId] : [])]));
  return (board.connectorEdges ?? []).filter((edge) => selected.has(edge.fromNodeId) && selected.has(edge.toNodeId));
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
export function enclosingIdsLookup(board: BoardData): (nodeId: string) => Set<string> {
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

/** Cluster by cluster: page, then bounding box top to bottom, left to right. Order within a cluster is kept. */
function readingOrder(board: BoardData, entries: IndexedEvidence[]): IndexedEvidence[] {
  const clustersById = new Map(board.clusters.map((cluster) => [cluster.id, cluster]));
  const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
  const pageOrder = new Map(board.nodes.filter((node) => node.type === "CANVAS" || node.type === "PAGE")
    .map((node, position) => [node.id, position]));
  const groups = new Map<string, { entries: IndexedEvidence[]; page: number; x: number; y: number; first: number }>();
  entries.forEach((entry, position) => {
    const { evidence } = entry;
    const key = evidence.clusterId ?? `node\0${evidence.renderNodeId ?? evidence.nodeId}`;
    let group = groups.get(key);
    if (!group) {
      const node = nodesById.get(evidence.renderNodeId ?? evidence.nodeId);
      const box = (evidence.clusterId ? clustersById.get(evidence.clusterId)?.boundingBox : undefined) ?? node;
      group = { entries: [], page: pageOrder.get(evidence.pageId ?? "") ?? -1, x: box?.x ?? 0, y: box?.y ?? 0, first: position };
      groups.set(key, group);
    }
    group.entries.push(entry);
  });
  return [...groups.values()]
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x || a.first - b.first)
    .flatMap((group) => group.entries);
}

/**
 * Names without text (frames, links, shapes) rank high on short BM25 fields and
 * would crowd out board text; they follow all content in a stable order.
 */
function contentFirst<T>(items: T[], evidenceOf: (item: T) => Evidence): T[] {
  const isMetadata = (item: T) => evidenceOf(item).sourceType === "board_metadata";
  return [...items.filter((item) => !isMetadata(item)), ...items.filter(isMetadata)];
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

export function formatEvidence(item: Evidence): string {
  const provenance = item.modelDerived ? "MODEL INTERPRETATION; verify against original" :
    item.sourceType === "board_metadata" ? "original board metadata" :
    item.sourceType === "table_row" ? `original table row; cells separated by "${TABLE_CELL_SEPARATOR.trim()}"` : "original board text";
  const metadata = [
    item.nodeName ? `Node name: ${item.nodeName}` : undefined,
    item.pageName ? `Page: ${item.pageName}` : undefined,
    item.sectionNames?.length ? `Sections: ${item.sectionNames.join(" / ")}` : undefined,
    item.sourceType === "table_cell" && item.renderNodeId ? `Table node: ${item.renderNodeId}` : undefined,
    item.row !== undefined ? `Row index: ${item.row}` : undefined,
    item.column !== undefined ? `Column index: ${item.column}` : undefined,
  ].filter(Boolean).join("; ");
  return `[${item.evidenceId}] ${item.nodeName ?? item.nodeId} (${provenance}; node ${item.nodeId})\n${item.clusterLabel ? `Cluster label: ${item.clusterLabel}\n` : ""}${metadata ? `Original source metadata: ${metadata}\n` : ""}${item.text}`;
}

export function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";
  let end = maxChars - 1;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
  return `${value.slice(0, end)}…`;
}

function addFieldScores(
  index: EvidenceIndex, field: EvidenceField, queryTerms: string[], scores: Map<number, number>,
  allowed?: Set<number>,
): void {
  const fieldIndex = index.fields[field];
  for (const term of queryTerms) {
    const alternatives = [{ term, weight: 1 }, ...compoundPrefixes(index.vocabulary, term)
      .map((prefix) => ({ term: prefix, weight: PREFIX_MATCH_WEIGHT }))];
    // A query word contributes once per field/chunk; several matching compounds
    // must not turn a partial match into an unbounded frequency bonus.
    const termScores = new Map<number, number>();
    for (const alternative of alternatives) {
      const postings = fieldIndex.postings.get(alternative.term) ?? [];
      const idf = Math.log(1 + (index.entries.length - postings.length + 0.5) / (postings.length + 0.5));
      for (const posting of postings) {
        if (allowed && !allowed.has(posting.index)) continue;
        const length = index.entries[posting.index]!.lengths[field];
        const normalization = 1.2 * (0.25 + 0.75 * length / fieldIndex.averageLength);
        const score = alternative.weight * FIELD_WEIGHTS[field] * idf * posting.frequency * 2.2 /
          (posting.frequency + normalization);
        termScores.set(posting.index, Math.max(termScores.get(posting.index) ?? 0, score));
      }
    }
    for (const [entry, score] of termScores) scores.set(entry, (scores.get(entry) ?? 0) + score);
  }
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
  const totalLengths: Record<EvidenceField, number> = { text: 0, node: 0, section: 0, page: 0, cluster: 0 };
  const entries: IndexedEvidence[] = [];
  for (const { evidence: item, cellIds } of sources) {
    const node = nodesById.get(item.renderNodeId ?? item.nodeId);
    const values = evidenceFields(item, node, nodesById);
    const lengths = {} as Record<EvidenceField, number>;
    const position = entries.length;
    for (const field of FIELDS) {
      const tokens = evidenceTokens(values[field]);
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
  const firstRows = new Map<string, Evidence[]>();
  for (const { evidence: item } of entries) {
    if (item.sourceType !== "table_row") continue;
    const rows = firstRows.get(item.nodeId);
    if (!rows) firstRows.set(item.nodeId, [item]);
    else if (rows[0]!.row === item.row) rows.push(item);
  }
  const index = { snapshotId, entries, fields, vocabulary, firstRows };
  indexes.set(board, index);
  return index;
}

function evidenceFields(
  item: Evidence, node: NormalizedNode | undefined, nodesById: Map<string, NormalizedNode>,
): Record<EvidenceField, string> {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const name = normalize(node?.name ?? "");
  const text = normalize(node?.text ?? "");
  // Figma frequently derives the node name from its full text or its opening.
  // Indexing that name on every chunk leaks a match into unrelated trailing text.
  const nameDuplicatesText = Boolean(name && text && text.startsWith(name));
  return {
    text: item.text,
    node: [item.sourceType === "board_metadata" || nameDuplicatesText ? "" : node?.name, node?.type]
      .filter(Boolean).join("\n"),
    section: (node?.sectionIds ?? []).map((id) => nodesById.get(id)?.name ?? "").join("\n"),
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
        chunkIndex,
        url: nodeLink(board, source.renderNodeId ?? source.nodeId),
        truncated: chunks.length > 1,
      }, ...(cellIds ? { cellIds } : {}) });
    }
  };
  const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
  for (const node of board.nodes) {
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
    } else if (node.text?.trim()) {
      append(node.text, { ...provenance, nodeId: node.id, sourceType: "board_text", modelDerived: false }, cluster);
    }
    if (!node.text?.trim() && !node.table?.cells.some((cell) => cell.text.trim()) && node.name.trim() &&
      !CONTAINER_TYPES.has(node.type) && !isGenericNodeName(node.name)) {
      append(node.name, { ...provenance, nodeId: node.id, sourceType: "board_metadata", modelDerived: false }, cluster);
    }
  }
  for (const cluster of board.clusters) {
    const modelDerived = cluster.summarySource === "vision_llm" || cluster.summarySource === "text_llm" || Boolean(cluster.modelId);
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
  return evidence;
}

/**
 * Cells with their row and column. Values recorded in the snapshot come first.
 * Otherwise, if every cell ID has the form T<table ID>;<row ID>;<column ID> and
 * together they form a complete rectangle, row and column are the positions of
 * the row and column IDs in order of first appearance; else both stay empty.
 */
export function tableCellPositions(table: NormalizedNode): TableCell[] {
  const cells = table.table?.cells ?? [];
  const prefix = `T${table.id};`;
  const rowIds = new Map<string, number>();
  const columnIds = new Map<string, number>();
  const pairs = new Set<string>();
  const derived: Array<{ row: number; column: number }> = [];
  for (const cell of cells) {
    const parts = cell.id.startsWith(prefix) ? cell.id.slice(prefix.length).split(";") : [];
    if (parts.length !== 2 || !parts[0] || !parts[1]) break;
    const [rowId, columnId] = parts as [string, string];
    if (!rowIds.has(rowId)) rowIds.set(rowId, rowIds.size);
    if (!columnIds.has(columnId)) columnIds.set(columnId, columnIds.size);
    pairs.add(`${rowId};${columnId}`);
    derived.push({ row: rowIds.get(rowId)!, column: columnIds.get(columnId)! });
  }
  const rectangle = derived.length === cells.length && pairs.size === cells.length &&
    pairs.size === rowIds.size * columnIds.size;
  return cells.map((cell, index) => {
    const row = cell.row ?? (rectangle ? derived[index]!.row : undefined);
    const column = cell.column ?? (rectangle ? derived[index]!.column : undefined);
    return { ...cell, ...(row === undefined ? {} : { row }), ...(column === undefined ? {} : { column }) };
  });
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
  Pick<Evidence, "pageId" | "sectionIds" | "renderNodeId" | "nodeName" | "pageName" | "sectionNames"> {
  const sectionIds = node?.sectionIds?.slice(-16);
  const pageName = node?.pageId ? nodesById.get(node.pageId)?.name : undefined;
  return {
    pageId: node?.pageId,
    sectionIds,
    renderNodeId: node?.renderNodeId,
    nodeName: node?.name ? boundedText(node.name, 160) : undefined,
    pageName: pageName ? boundedText(pageName, 160) : undefined,
    sectionNames: sectionIds?.map((id) => nodesById.get(id)?.name)
      .filter((name): name is string => Boolean(name)).map((name) => boundedText(name, 80)),
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
