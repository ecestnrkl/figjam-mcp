import { createHash } from "node:crypto";
import { connectorArrow } from "./connectorGraph.js";
import type { BoardData, ConnectorEdge, NormalizedNode, RefinedCluster } from "../types.js";

export const EVIDENCE_CHUNK_CHARS = 1200;
export const MAX_CONTEXT_RESPONSE_BYTES = 128 * 1024;
const MAX_INDEX_ENTRIES = 100_000;

/** Original board text and model interpretations remain distinguishable at every boundary. */
export interface Evidence {
  evidenceId: string;
  snapshotId: string;
  nodeId: string;
  text: string;
  sourceType: "board_text" | "table_cell" | "board_metadata" | "model_interpretation" | "cluster_summary";
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
}

export interface EvidenceResult {
  snapshotId: string;
  evidence: Evidence[];
  connections: EvidenceConnection[];
  totalMatched: number;
}

interface IndexedEvidence {
  evidence: Evidence;
  length: number;
}

interface EvidenceIndex {
  snapshotId: string;
  entries: IndexedEvidence[];
  postings: Map<string, Array<{ index: number; frequency: number }>>;
  averageLength: number;
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

export function nodeLink(board: BoardData, nodeId: string): string {
  return `https://www.figma.com/board/${encodeURIComponent(board.fileKey)}?node-id=${encodeURIComponent(nodeId)}`;
}

/** Deterministic lexical BM25 over original node/cell chunks, with light label boosts. */
export function retrieveEvidence(board: BoardData, options: EvidenceQuery = {}): EvidenceResult {
  const index = getIndex(board);
  let matches: IndexedEvidence[];
  if (options.nodeIds) {
    const requested = new Set(options.nodeIds);
    matches = index.entries.filter(({ evidence }) =>
      requested.has(evidence.nodeId) || Boolean(evidence.renderNodeId && requested.has(evidence.renderNodeId)),
    );
  } else if (options.query?.trim()) {
    const queryTerms = [...new Set(evidenceTokens(options.query))];
    const scores = new Map<number, number>();
    for (const term of queryTerms) {
      const postings = index.postings.get(term) ?? [];
      const idf = Math.log(1 + (index.entries.length - postings.length + 0.5) / (postings.length + 0.5));
      for (const posting of postings) {
        const document = index.entries[posting.index]!;
        const normalization = 1.2 * (0.25 + 0.75 * document.length / index.averageLength);
        const score = idf * posting.frequency * 2.2 / (posting.frequency + normalization);
        scores.set(posting.index, (scores.get(posting.index) ?? 0) + score);
      }
    }
    matches = [...scores.entries()]
      .sort(([a, aScore], [b, bScore]) => bScore - aScore || a - b)
      .map(([entry]) => index.entries[entry]!);
  } else {
    // A board overview covers different areas before spending its budget on another
    // paragraph from the same large cluster. Order remains stable for pagination.
    matches = interleaveClusters(index.entries);
  }

  const totalMatched = matches.length;
  const selected = (options.limit === undefined ? matches : matches.slice(0, options.limit))
    .map((entry) => entry.evidence);
  if (options.includeNeighbors && selected.length > 0) {
    addNeighbors(board, index, selected, options.neighborLimit ?? 6);
  }
  return {
    snapshotId: index.snapshotId,
    evidence: selected,
    connections: connectionsForEvidence(board, selected),
    totalMatched,
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

function interleaveClusters(entries: IndexedEvidence[]): IndexedEvidence[] {
  const groups = new Map<string, IndexedEvidence[]>();
  for (const entry of entries) {
    const key = entry.evidence.clusterId ?? entry.evidence.nodeId;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const ordered: IndexedEvidence[] = [];
  let active = [...groups.values()];
  for (let offset = 0; active.length; offset++) {
    const next: IndexedEvidence[][] = [];
    for (const group of active) {
      ordered.push(group[offset]!);
      if (group.length > offset + 1) next.push(group);
    }
    active = next;
  }
  return ordered;
}

export function formatEvidence(item: Evidence): string {
  const provenance = item.modelDerived ? "MODEL INTERPRETATION; verify against original" :
    item.sourceType === "board_metadata" ? "original board metadata" : "original board text";
  const metadata = [
    item.nodeName ? `Node name: ${item.nodeName}` : undefined,
    item.pageName ? `Page: ${item.pageName}` : undefined,
    item.sectionNames?.length ? `Sections: ${item.sectionNames.join(" / ")}` : undefined,
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

function getIndex(board: BoardData): EvidenceIndex {
  const existing = indexes.get(board);
  if (existing) return existing;
  const snapshotId = snapshotIdForBoard(board);
  const evidence = buildEvidence(board, snapshotId);
  const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
  const metadataById = new Map(board.nodes.map((node) => [node.id, descriptiveMetadata(node, nodesById)]));
  const entries: IndexedEvidence[] = [];
  const postings: EvidenceIndex["postings"] = new Map();
  let totalLength = 0;
  for (const item of evidence) {
    const tokens = evidenceTokens(item.text);
    const terms = new Map<string, number>();
    for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
    // Search node names and the source page/section names without replacing the
    // original excerpt by a synthesized summary. Cells inherit their table metadata.
    const metadata = metadataById.get(item.renderNodeId ?? item.nodeId) ?? "";
    for (const token of new Set(evidenceTokens(metadata))) {
      terms.set(token, (terms.get(token) ?? 0) + 0.5);
    }
    // Small label boosts preserve framework/topic discovery without discarding the original text.
    for (const token of new Set(evidenceTokens(item.clusterLabel ?? ""))) {
      terms.set(token, (terms.get(token) ?? 0) + 0.35);
    }
    const length = Math.max(1, tokens.length);
    const position = entries.length;
    entries.push({ evidence: item, length });
    totalLength += length;
    for (const [term, frequency] of terms) {
      const list = postings.get(term) ?? [];
      list.push({ index: position, frequency });
      postings.set(term, list);
    }
  }
  const index = { snapshotId, entries, postings, averageLength: totalLength / Math.max(1, entries.length) || 1 };
  indexes.set(board, index);
  return index;
}

function buildEvidence(board: BoardData, snapshotId: string): Evidence[] {
  const clusterOf = new Map<string, RefinedCluster>();
  for (const cluster of board.clusters) {
    for (const nodeId of cluster.nodeIds) if (!clusterOf.has(nodeId)) clusterOf.set(nodeId, cluster);
  }
  const evidence: Evidence[] = [];
  const append = (
    text: string,
    source: Pick<Evidence, "nodeId" | "sourceType" | "modelDerived"> & Partial<Evidence>,
    cluster?: RefinedCluster,
  ) => {
    const chunks = chunkText(text);
    for (const [chunkIndex, chunk] of chunks.entries()) {
      if (evidence.length >= MAX_INDEX_ENTRIES) {
        throw new Error(`Board exceeds the ${MAX_INDEX_ENTRIES}-chunk evidence limit. Ingest a smaller board or page.`);
      }
      evidence.push({
        ...source,
        evidenceId: `ev_${digest(`${snapshotId}\0${source.sourceType}\0${source.nodeId}\0${source.modelDerived ? cluster?.id ?? "" : ""}\0${chunkIndex}\0${chunk}`).slice(0, 32)}`,
        snapshotId,
        nodeId: source.nodeId,
        text: chunk,
        clusterId: cluster?.id,
        clusterLabel: cluster ? boundedText(cluster.label, 160) : undefined,
        chunkIndex,
        url: nodeLink(board, source.renderNodeId ?? source.nodeId),
        truncated: chunks.length > 1,
      });
    }
  };
  const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
  for (const node of board.nodes) {
    const cluster = clusterOf.get(node.id);
    const provenance = nodeProvenance(node, nodesById);
    if (node.table?.cells.length) {
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
    if (!node.text?.trim() && !node.table?.cells.some((cell) => cell.text.trim()) && node.name.trim()) {
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

function descriptiveMetadata(node: NormalizedNode, nodesById: Map<string, NormalizedNode>): string {
  return [node.name, node.type, node.pageId ? nodesById.get(node.pageId)?.name : undefined,
    ...(node.sectionIds ?? []).map((id) => nodesById.get(id)?.name)]
    .filter((value): value is string => Boolean(value)).join("\n");
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

function addNeighbors(board: BoardData, index: EvidenceIndex, selected: Evidence[], limit: number): void {
  const primaryNodes = new Set(selected.flatMap((item) => [item.nodeId, ...(item.renderNodeId ? [item.renderNodeId] : [])]));
  const neighborIds = new Set<string>();
  for (const edge of board.connectorEdges ?? []) {
    if (primaryNodes.has(edge.fromNodeId)) neighborIds.add(edge.toNodeId);
    if (primaryNodes.has(edge.toNodeId)) neighborIds.add(edge.fromNodeId);
  }
  const existing = new Set(selected.map((item) => item.evidenceId));
  const groups = new Map<string, Evidence[]>();
  for (const { evidence: item } of index.entries) {
    if (existing.has(item.evidenceId) || !(neighborIds.has(item.nodeId) || Boolean(item.renderNodeId && neighborIds.has(item.renderNodeId)))) continue;
    const key = item.renderNodeId ?? item.nodeId;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  let added = 0;
  // Each connected node/table gets one excerpt before a long neighbor receives a second.
  let active = [...groups.values()];
  for (let offset = 0; active.length && added < limit; offset++) {
    const next: Evidence[][] = [];
    for (const group of active) {
      if (added >= limit) break;
      selected.push(group[offset]!);
      added++;
      if (group.length > offset + 1) next.push(group);
    }
    active = next;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
