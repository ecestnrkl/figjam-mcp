import type { BoardData, ConnectorEdge, NormalizedNode, RefinedCluster, TableCell } from "../types.js";
import { isGenericNodeName, STRUCTURAL_TYPES } from "./nodeTree.js";
import { hashClusterNodes } from "./persistentCache.js";
import { connectorArrow } from "./connectorGraph.js";
import { boundedText, nodeLink, tableCellPositions } from "./evidence.js";

/**
 * Compares two ingest snapshots of the same board — "what changed since the
 * last workshop?". Works on three levels:
 *  - nodes: added / removed / edited content nodes (structural containers
 *    and connectors excluded — connectors are diffed separately),
 *    and named with their section and old and new text,
 *  - clusters: matched across snapshots by member overlap, then classified
 *    as unchanged (same content hash), modified, new, or removed,
 *  - connections: connector arrows diffed as (from, to, label) edges and
 *    rendered with the owning clusters' labels.
 */

export interface ClusterSummaryRef {
  label: string;
  summary: string;
}

export interface ModifiedClusterDiff {
  label: string;
  previousLabel: string;
  addedNodeCount: number;
  removedNodeCount: number;
  editedNodeCount: number;
}

export interface BoardDiffStats {
  addedNodes: number;
  removedNodes: number;
  editedNodes: number;
  newClusters: number;
  removedClusters: number;
  modifiedClusters: number;
  unchangedClusters: number;
  addedConnections: number;
  removedConnections: number;
}

export interface BoardDiffResult {
  stats: BoardDiffStats;
  newClusters: ClusterSummaryRef[];
  removedClusters: ClusterSummaryRef[];
  modifiedClusters: ModifiedClusterDiff[];
  addedConnections: string[];
  removedConnections: string[];
  summaryText: string;
  tableCellChanges: TableCellChange[];
  nodeChanges: NodeChange[];
  /** Changed nodes beyond the NODE_CHANGE_LIMIT entries in nodeChanges. */
  nodeChangesOmitted?: number;
}

/** What differs on an edited node; "appearance" only when nothing else explains a changed contentFingerprint. */
export type NodeChangeAspect = "text" | "name" | "image" | "rotation" | "type" | "appearance";

export interface NodeChange {
  nodeId: string;
  changeType: "added" | "removed" | "edited";
  nodeType: string;
  /** Shown only when the text did not change and the name is neither a default name nor the text itself. */
  name?: string;
  /** The name before a rename, shown with name. */
  previousName?: string;
  /** Innermost section; absent outside sections. */
  sectionId?: string;
  section?: string;
  /** Whitespace-collapsed excerpts, see textExcerpts. */
  previousText?: string;
  currentText?: string;
  url: string;
  changes?: NodeChangeAspect[];
}

export interface TableCellChange {
  tableNodeId: string;
  cellId: string;
  changeType: "added" | "removed" | "modified";
  previousText?: string;
  currentText?: string;
  previousRow?: number;
  previousColumn?: number;
  currentRow?: number;
  currentColumn?: number;
  /** From the current table, the baseline's for removed cells; absent for default names. */
  tableName?: string;
  /** Text of the first cell in the row, absent when empty or the changed cell itself. */
  rowLabel?: string;
  /** Text of the cell in the first row of the column, absent when empty or the changed cell itself. */
  columnLabel?: string;
}

/** Minimum member overlap (relative to the smaller cluster) to treat two clusters as the same. */
const CLUSTER_MATCH_THRESHOLD = 0.5;

/** Max entries rendered per section in summaryText. */
const SUMMARY_SECTION_LIMIT = 8;
/** Max entries in nodeChanges, and lines per node or table cell block in summaryText. */
const NODE_CHANGE_LIMIT = 100;
const NODE_LINES_PER_BLOCK = 20;
/** Texts up to this length are shown whole; longer new or removed texts are cut here. */
const FULL_TEXT_CHARS = 160;
/** Context around the changed part of a longer edited text, and the cap for each side. */
const EDIT_CONTEXT_CHARS = 40;
const EDIT_EXCERPT_CHARS = 300;
const NAME_CHARS = 80;
const READABLE_TYPES: Record<string, string> = {
  SHAPE_WITH_TEXT: "shape", LINK_UNFURL: "link", BOOLEAN_OPERATION: "shape", REGULAR_POLYGON: "polygon",
};

export function diffBoards(baseline: BoardData, current: BoardData): BoardDiffResult {
  const baselineNodes = contentNodesById(baseline);
  const currentNodes = contentNodesById(current);

  const addedNodeIds = [...currentNodes.keys()].filter((id) => !baselineNodes.has(id));
  const removedNodeIds = [...baselineNodes.keys()].filter((id) => !currentNodes.has(id));
  const editedNodeIds = [...currentNodes.keys()].filter((id) => {
    const before = baselineNodes.get(id);
    return before !== undefined && nodeContentChanged(before, currentNodes.get(id)!);
  });

  const clusterDiff = diffClusters(baseline, current);
  const connectionDiff = diffConnections(baseline, current);
  const tableCellChanges = diffTableCells(baselineNodes, currentNodes);
  const nodeDiff = describeNodeChanges(baseline, current, addedNodeIds, removedNodeIds, editedNodeIds);

  const stats: BoardDiffStats = {
    addedNodes: addedNodeIds.length,
    removedNodes: removedNodeIds.length,
    editedNodes: editedNodeIds.length,
    newClusters: clusterDiff.newClusters.length,
    removedClusters: clusterDiff.removedClusters.length,
    modifiedClusters: clusterDiff.modifiedClusters.length,
    unchangedClusters: clusterDiff.unchangedClusters,
    addedConnections: connectionDiff.added.length,
    removedConnections: connectionDiff.removed.length,
  };

  return {
    stats,
    newClusters: clusterDiff.newClusters,
    removedClusters: clusterDiff.removedClusters,
    modifiedClusters: clusterDiff.modifiedClusters,
    addedConnections: connectionDiff.added,
    removedConnections: connectionDiff.removed,
    summaryText: buildSummaryText(baseline, current, stats, clusterDiff, connectionDiff, nodeDiff, tableCellChanges),
    tableCellChanges,
    nodeChanges: nodeDiff.entries,
    ...(nodeDiff.omitted > 0 ? { nodeChangesOmitted: nodeDiff.omitted } : {}),
  };
}

/** Leaf content nodes: everything except structural containers and connectors. */
function contentNodesById(board: BoardData): Map<string, NormalizedNode> {
  const map = new Map<string, NormalizedNode>();
  for (const node of board.nodes) {
    if (!STRUCTURAL_TYPES.has(node.type) && node.type !== "CONNECTOR") {
      map.set(node.id, node);
    }
  }
  return map;
}

function nodeContentChanged(before: NormalizedNode, after: NormalizedNode): boolean {
  return (before.text ?? "") !== (after.text ?? "") ||
    before.imageRef !== after.imageRef || before.name !== after.name || before.type !== after.type ||
    before.rotation !== after.rotation ||
    JSON.stringify(before.table?.cells) !== JSON.stringify(after.table?.cells) ||
    (before.contentFingerprint !== undefined && after.contentFingerprint !== undefined &&
      before.contentFingerprint !== after.contentFingerprint);
}

interface NodeChangeItem {
  change: NodeChange;
  before?: NormalizedNode;
  after?: NormalizedNode;
  /** The snapshot the node is named from: the current one, the baseline for removed nodes. */
  board: BoardData;
}

interface NodeDiffInternal {
  entries: NodeChange[];
  omitted: number;
  /** Per block: the first NODE_LINES_PER_BLOCK items and the total. */
  blocks: Array<{ title: string; shown: NodeChangeItem[]; total: number }>;
}

/**
 * Entries for edited, then added, then removed nodes, each in reading order.
 * A table whose change is explained by its cells has no entry: tableCellChanges
 * names them. Entries are built only for what nodeChanges and summaryText show.
 */
function describeNodeChanges(
  baseline: BoardData, current: BoardData, addedIds: string[], removedIds: string[], editedIds: string[],
): NodeDiffInternal {
  const before = new Map(baseline.nodes.map((node) => [node.id, node]));
  const after = new Map(current.nodes.map((node) => [node.id, node]));
  const aspects = new Map(editedIds.map((id) => [id, changedAspects(before.get(id)!, after.get(id)!)]));
  const groups = [
    { title: "Edited nodes", ids: readingOrder(current, editedIds.filter((id) => aspects.get(id)!.length > 0)) },
    { title: "Added nodes", ids: readingOrder(current, addedIds) },
    { title: "Removed nodes", ids: readingOrder(baseline, removedIds) },
  ];
  const built = new Map<string, NodeChangeItem>();
  const item = (id: string): NodeChangeItem => {
    let result = built.get(id);
    if (!result) {
      const previous = before.get(id);
      const next = after.get(id);
      result = previous && next
        ? { change: editedEntry(current, previous, next, aspects.get(id)!), before: previous, after: next, board: current }
        : next ? { change: createdEntry(current, next, "added"), after: next, board: current }
          : { change: createdEntry(baseline, previous!, "removed"), before: previous, board: baseline };
      built.set(id, result);
    }
    return result;
  };
  const all = groups.flatMap((group) => group.ids);
  return {
    entries: all.slice(0, NODE_CHANGE_LIMIT).map((id) => item(id).change),
    omitted: Math.max(0, all.length - NODE_CHANGE_LIMIT),
    blocks: groups.map((group) => ({
      title: group.title, total: group.ids.length, shown: group.ids.slice(0, NODE_LINES_PER_BLOCK).map(item),
    })),
  };
}

function changedAspects(before: NormalizedNode, after: NormalizedNode): NodeChangeAspect[] {
  const cellsChanged = JSON.stringify(before.table?.cells) !== JSON.stringify(after.table?.cells);
  const aspects: NodeChangeAspect[] = [];
  // A table's text is its cells' text; changed cells explain it.
  if ((before.text ?? "") !== (after.text ?? "") && !cellsChanged) aspects.push("text");
  if (before.name !== after.name) aspects.push("name");
  if (before.imageRef !== after.imageRef) aspects.push("image");
  if (before.rotation !== after.rotation) aspects.push("rotation");
  if (before.type !== after.type) aspects.push("type");
  if (aspects.length === 0 && !cellsChanged && before.contentFingerprint !== after.contentFingerprint) {
    aspects.push("appearance");
  }
  return aspects;
}

function entryBase(board: BoardData, node: NormalizedNode, changeType: NodeChange["changeType"]): NodeChange {
  return { nodeId: node.id, changeType, nodeType: node.type, ...sectionOf(board, node), url: nodeLink(board, node.id) };
}

/** The innermost section around a node, with its name when it has one. */
function sectionOf(board: BoardData, node: NormalizedNode): { sectionId?: string; section?: string } {
  const sectionId = node.sectionIds?.at(-1);
  if (!sectionId) return {};
  const section = collapseWhitespace(board.nodes.find((item) => item.id === sectionId)?.name);
  return { sectionId, ...(section ? { section: boundedText(section, NAME_CHARS) } : {}) };
}

function createdEntry(board: BoardData, node: NormalizedNode, changeType: "added" | "removed"): NodeChange {
  const text = collapseWhitespace(node.text);
  const name = shownName(node);
  return {
    ...entryBase(board, node, changeType),
    ...(name ? { name } : {}),
    ...(text === undefined ? {} : changeType === "added" ? { currentText: leadingText(text) } : { previousText: leadingText(text) }),
  };
}

function editedEntry(current: BoardData, before: NormalizedNode, after: NormalizedNode, changes: NodeChangeAspect[]): NodeChange {
  const [previousText, currentText] = textExcerpts(collapseWhitespace(before.text), collapseWhitespace(after.text));
  const textChanged = changes.includes("text");
  const renamed = !textChanged && changes.includes("name");
  const name = textChanged ? undefined : renamed ? boundedName(after.name) : shownName(after);
  return {
    ...entryBase(current, after, "edited"),
    ...(name ? { name } : {}),
    ...(renamed ? { previousName: boundedName(before.name) } : {}),
    ...(previousText === undefined ? {} : { previousText }),
    ...(currentText === undefined ? {} : { currentText }),
    changes,
  };
}

/** A name that says more than the node's type or text. */
function shownName(node: NormalizedNode): string | undefined {
  const name = collapseWhitespace(node.name);
  if (!name || isGenericNodeName(name) || collapseWhitespace(node.text)?.startsWith(name)) return undefined;
  return boundedText(name, NAME_CHARS);
}

function boundedName(name: string): string {
  return boundedText(collapseWhitespace(name) ?? "", NAME_CHARS);
}

/** Cluster by cluster, as get_board_context reads: page, then top to bottom, left to right; snapshot order within. */
function readingOrder(board: BoardData, ids: string[]): string[] {
  const position = new Map(board.nodes.map((node, index) => [node.id, index]));
  const nodes = new Map(board.nodes.map((node) => [node.id, node]));
  const pages = new Map(board.nodes.filter((node) => node.type === "CANVAS" || node.type === "PAGE")
    .map((node, index) => [node.id, index]));
  const owner = new Map<string, RefinedCluster>();
  for (const cluster of board.clusters) for (const id of cluster.nodeIds) if (!owner.has(id)) owner.set(id, cluster);
  const keyed = ids.map((id) => {
    const node = nodes.get(id)!;
    const cluster = owner.get(id);
    const box = cluster?.boundingBox ?? node;
    return { id, group: cluster?.id ?? `node\0${id}`, page: pages.get(node.pageId ?? "") ?? -1, x: box.x, y: box.y, at: position.get(id)! };
  });
  const first = new Map<string, number>();
  for (const key of keyed) first.set(key.group, Math.min(first.get(key.group) ?? Infinity, key.at));
  return keyed.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x ||
    first.get(a.group)! - first.get(b.group)! || a.at - b.at).map((key) => key.id);
}

function collapseWhitespace(text: string | undefined): string | undefined {
  return text?.replace(/\s+/g, " ").trim() || undefined;
}

/** The first FULL_TEXT_CHARS characters, then "…". */
function leadingText(text: string): string {
  return text.length <= FULL_TEXT_CHARS ? text : `${text.slice(0, surrogateSafe(text, FULL_TEXT_CHARS))}…`;
}

/**
 * Both texts whole up to FULL_TEXT_CHARS. Otherwise only the changed words on each
 * side, with up to EDIT_CONTEXT_CHARS of context before and after, cut at word
 * boundaries and marked with "…", at most EDIT_EXCERPT_CHARS per side.
 */
function textExcerpts(before: string | undefined, after: string | undefined): [string | undefined, string | undefined] {
  if (before === undefined || after === undefined) {
    return [before === undefined ? undefined : leadingText(before), after === undefined ? undefined : leadingText(after)];
  }
  if (before.length <= FULL_TEXT_CHARS && after.length <= FULL_TEXT_CHARS) return [before, after];
  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before[start] === after[start]) start++;
  let end = 0;
  while (end < shorter - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  // The common prefix and suffix are equal on both sides, so word boundaries are too.
  while (start > 0 && before[start - 1] !== " ") start--;
  while (end > 0 && before[before.length - end] !== " ") end--;
  return [changedPart(before, start, before.length - end), changedPart(after, start, after.length - end)];
}

/** text[from, to) starts and ends at a word boundary. */
function changedPart(text: string, from: number, to: number): string {
  let head = Math.max(0, from - EDIT_CONTEXT_CHARS);
  if (head > 0) head = Math.min(from, text.indexOf(" ", head - 1) + 1);
  let tail = Math.min(text.length, to + EDIT_CONTEXT_CHARS);
  if (tail < text.length) tail = Math.max(to, text.lastIndexOf(" ", tail));
  const lead = head > 0 ? "…" : "";
  const body = text.slice(head, tail).trim();
  const trail = tail < text.length ? "…" : "";
  if (lead.length + body.length + trail.length <= EDIT_EXCERPT_CHARS) return `${lead}${body}${trail}`;
  const room = EDIT_EXCERPT_CHARS - lead.length - 1;
  const space = body.lastIndexOf(" ", room);
  return `${lead}${body.slice(0, space > room / 2 ? space : surrogateSafe(body, room)).trimEnd()}…`;
}

/** Moves a cut back by one when it would split a surrogate pair. */
function surrogateSafe(text: string, index: number): number {
  return index > 0 && /[\uD800-\uDBFF]/.test(text[index - 1]!) ? index - 1 : index;
}

/**
 * Whether a cell changed depends on its text and the positions stored in the
 * snapshot. Positions derived from cell IDs only label the change: compared,
 * a row inserted without stored positions would move every cell below it.
 */
function diffTableCells(
  beforeNodes: Map<string, NormalizedNode>,
  afterNodes: Map<string, NormalizedNode>,
): TableCellChange[] {
  const changes: TableCellChange[] = [];
  const tableIds = new Set([
    ...[...beforeNodes.values()].filter((node) => node.table).map((node) => node.id),
    ...[...afterNodes.values()].filter((node) => node.table).map((node) => node.id),
  ]);
  for (const tableNodeId of tableIds) {
    const before = new Map((beforeNodes.get(tableNodeId)?.table?.cells ?? []).map((cell) => [cell.id, cell]));
    const after = new Map((afterNodes.get(tableNodeId)?.table?.cells ?? []).map((cell) => [cell.id, cell]));
    let layouts: [TableLayout, TableLayout] | undefined;
    for (const cellId of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(cellId);
      const current = after.get(cellId);
      if (previous && current && previous.text === current.text && previous.row === current.row &&
          previous.column === current.column) continue;
      layouts ??= [tableLayout(beforeNodes.get(tableNodeId)), tableLayout(afterNodes.get(tableNodeId))];
      const [oldLayout, newLayout] = layouts;
      const shownBefore = oldLayout.cells.get(cellId);
      const shownAfter = newLayout.cells.get(cellId);
      changes.push({
        tableNodeId, cellId,
        changeType: !previous ? "added" : !current ? "removed" : "modified",
        previousText: previous?.text, currentText: current?.text,
        previousRow: shownBefore?.row, previousColumn: shownBefore?.column,
        currentRow: shownAfter?.row, currentColumn: shownAfter?.column,
        ...(current ? newLayout : oldLayout).labels(cellId),
      });
    }
  }
  return changes;
}

interface TableLayout {
  cells: Map<string, TableCell>;
  labels(cellId: string): Pick<TableCellChange, "tableName" | "rowLabel" | "columnLabel">;
}

/** Cells with positions as get_board_context reads them, and the labels of their row and column. */
function tableLayout(table: NormalizedNode | undefined): TableLayout {
  const cells = table?.table ? tableCellPositions(table) : [];
  const rowHeads = new Map<number, TableCell>();
  const columnHeads = new Map<number, TableCell>();
  for (const cell of cells) {
    if (cell.row === undefined || cell.column === undefined) continue;
    if (cell.column < (rowHeads.get(cell.row)?.column ?? Infinity)) rowHeads.set(cell.row, cell);
    if (cell.row < (columnHeads.get(cell.column)?.row ?? Infinity)) columnHeads.set(cell.column, cell);
  }
  const name = table && !isGenericNodeName(table.name) ? collapseWhitespace(table.name) : undefined;
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const label = (head: TableCell | undefined, cellId: string) => {
    const text = head && head.id !== cellId ? collapseWhitespace(head.text) : undefined;
    return text ? boundedText(text, NAME_CHARS) : undefined;
  };
  return {
    cells: byId,
    labels(cellId) {
      const cell = byId.get(cellId);
      const rowLabel = cell?.row === undefined ? undefined : label(rowHeads.get(cell.row), cellId);
      const columnLabel = cell?.column === undefined ? undefined : label(columnHeads.get(cell.column), cellId);
      return {
        ...(name ? { tableName: boundedText(name, NAME_CHARS) } : {}),
        ...(rowLabel ? { rowLabel } : {}),
        ...(columnLabel ? { columnLabel } : {}),
      };
    },
  };
}

interface ClusterDiffInternal {
  newClusters: ClusterSummaryRef[];
  removedClusters: ClusterSummaryRef[];
  modifiedClusters: ModifiedClusterDiff[];
  unchangedClusters: number;
}

/**
 * Greedy best-overlap matching: cluster pairs are ranked by shared member
 * count and matched one-to-one while the overlap covers at least half of
 * the smaller cluster. Matched pairs with identical content hashes count as
 * unchanged; everything unmatched is new (current side) or removed
 * (baseline side).
 */
function diffClusters(baseline: BoardData, current: BoardData): ClusterDiffInternal {
  const baselineNodesById = new Map(baseline.nodes.map((node) => [node.id, node]));
  const currentNodesById = new Map(current.nodes.map((node) => [node.id, node]));

  const pairs: Array<{ prev: RefinedCluster; cur: RefinedCluster; overlap: number }> = [];
  const previousByMember = new Map<string, RefinedCluster[]>();
  for (const prev of baseline.clusters) {
    for (const id of new Set(prev.nodeIds)) {
      const owners = previousByMember.get(id) ?? [];
      owners.push(prev); previousByMember.set(id, owners);
    }
  }
  for (const cur of current.clusters) {
    const overlaps = new Map<RefinedCluster, number>();
    for (const id of cur.nodeIds) {
      for (const prev of previousByMember.get(id) ?? []) overlaps.set(prev, (overlaps.get(prev) ?? 0) + 1);
    }
    for (const [prev, overlap] of overlaps) {
      if (overlap / Math.min(prev.nodeIds.length, cur.nodeIds.length) >= CLUSTER_MATCH_THRESHOLD) pairs.push({ prev, cur, overlap });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap);

  const matchedPrev = new Set<string>();
  const matchedCur = new Set<string>();
  const modifiedClusters: ModifiedClusterDiff[] = [];
  let unchangedClusters = 0;

  for (const { prev, cur } of pairs) {
    if (matchedPrev.has(prev.id) || matchedCur.has(cur.id)) {
      continue;
    }
    matchedPrev.add(prev.id);
    matchedCur.add(cur.id);

    const prevMembers = membersOf(prev, baselineNodesById);
    const curMembers = membersOf(cur, currentNodesById);
    if (hashClusterNodes(prevMembers) === hashClusterNodes(curMembers)) {
      unchangedClusters++;
      continue;
    }

    const prevIds = new Set(prev.nodeIds);
    const curIds = new Set(cur.nodeIds);
    const sharedIds = cur.nodeIds.filter((id) => prevIds.has(id));
    modifiedClusters.push({
      label: cur.label,
      previousLabel: prev.label,
      addedNodeCount: cur.nodeIds.filter((id) => !prevIds.has(id)).length,
      removedNodeCount: prev.nodeIds.filter((id) => !curIds.has(id)).length,
      editedNodeCount: sharedIds.filter((id) => {
        const before = baselineNodesById.get(id);
        const after = currentNodesById.get(id);
        return before !== undefined && after !== undefined && nodeContentChanged(before, after);
      }).length,
    });
  }

  return {
    newClusters: current.clusters
      .filter((cluster) => !matchedCur.has(cluster.id))
      .map((cluster) => ({ label: cluster.label, summary: cluster.summary })),
    removedClusters: baseline.clusters
      .filter((cluster) => !matchedPrev.has(cluster.id))
      .map((cluster) => ({ label: cluster.label, summary: cluster.summary })),
    modifiedClusters,
    unchangedClusters,
  };
}

function membersOf(
  cluster: RefinedCluster,
  nodesById: Map<string, NormalizedNode>,
): NormalizedNode[] {
  return cluster.nodeIds
    .map((id) => nodesById.get(id))
    .filter((node): node is NormalizedNode => node !== undefined);
}

interface ConnectionDiffInternal {
  added: string[];
  removed: string[];
}

/**
 * Diffs connector edges as a multiset of (from, to, label) tuples.
 *
 * Connector IDs are deliberately ignored: replacing an arrow without changing
 * its meaning is not a semantic board change. Multiplicity still matters,
 * though — removing one of two parallel arrows must be reported.
 */
function diffConnections(baseline: BoardData, current: BoardData): ConnectionDiffInternal {
  const baselineEdges = groupEdgesByMeaning(baseline.connectorEdges ?? []);
  const currentEdges = groupEdgesByMeaning(current.connectorEdges ?? []);
  const keys = new Set([...baselineEdges.keys(), ...currentEdges.keys()]);
  const added: string[] = [];
  const removed: string[] = [];
  const baselineLabel = edgeFormatter(baseline);
  const currentLabel = edgeFormatter(current);

  for (const key of keys) {
    const before = baselineEdges.get(key) ?? [];
    const after = currentEdges.get(key) ?? [];

    for (let index = before.length; index < after.length; index++) {
      added.push(currentLabel(after[index]!));
    }
    for (let index = after.length; index < before.length; index++) {
      removed.push(baselineLabel(before[index]!));
    }
  }

  return { added, removed };
}

function groupEdgesByMeaning(edges: ConnectorEdge[]): Map<string, ConnectorEdge[]> {
  const grouped = new Map<string, ConnectorEdge[]>();
  for (const edge of edges) {
    const direction = edge.direction ?? "forward";
    const endpoints = direction === "reverse"
      ? [edge.toNodeId, edge.fromNodeId]
      : direction === "bidirectional" || direction === "undirected"
        ? [edge.fromNodeId, edge.toNodeId].sort()
        : [edge.fromNodeId, edge.toNodeId];
    const key = JSON.stringify([endpoints, direction === "reverse" ? "forward" : direction, edge.label ?? ""]);
    const matches = grouped.get(key) ?? [];
    matches.push(edge);
    grouped.set(key, matches);
  }
  return grouped;
}

/** Renders one edge with the owning clusters' labels (from its own snapshot). */
function edgeFormatter(board: BoardData): (edge: ConnectorEdge) => string {
  const owner = new Map<string, RefinedCluster>();
  const nodes = new Map(board.nodes.map(node => [node.id, node]));
  for (const cluster of board.clusters) for (const id of cluster.nodeIds) owner.set(id, cluster);
  return edge => {
    const internal = owner.has(edge.fromNodeId) && owner.get(edge.fromNodeId) === owner.get(edge.toNodeId);
    const label = (id: string) => {
      const cluster = owner.get(id);
      if (cluster && !internal) return cluster.label;
      const node = nodes.get(id); const text = node?.text?.trim();
      return text ? truncate(text, 40) : node?.name ?? id;
    };
    return `"${label(edge.fromNodeId)}" ${connectorArrow(edge)} "${label(edge.toNodeId)}"${edge.label ? ` — "${edge.label}"` : ""}`;
  };
}

function buildSummaryText(
  baseline: BoardData,
  current: BoardData,
  stats: BoardDiffStats,
  clusters: ClusterDiffInternal,
  connections: ConnectionDiffInternal,
  nodes: NodeDiffInternal,
  tableCells: TableCellChange[],
): string {
  const lines: string[] = [
    `FigJam board ${current.fileKey} — changes from ${timestamp(baseline.createdAt)} to ${timestamp(current.createdAt)}:`,
    "",
  ];

  if (
    stats.addedNodes + stats.removedNodes + stats.editedNodes === 0 &&
    stats.newClusters + stats.removedClusters + stats.modifiedClusters === 0 &&
    stats.addedConnections + stats.removedConnections === 0
  ) {
    lines.push("No changes — the board content is identical.");
    return lines.join("\n");
  }

  if (clusters.newClusters.length > 0) {
    lines.push(`New clusters (${clusters.newClusters.length}):`);
    lines.push(
      ...capped(clusters.newClusters, (c) => `- "${c.label}": ${firstSentence(c.summary)}`),
    );
  }
  if (clusters.removedClusters.length > 0) {
    lines.push(`Removed clusters (${clusters.removedClusters.length}):`);
    lines.push(...capped(clusters.removedClusters, (c) => `- "${c.label}"`));
  }
  if (clusters.modifiedClusters.length > 0) {
    lines.push(`Modified clusters (${clusters.modifiedClusters.length}):`);
    lines.push(
      ...capped(clusters.modifiedClusters, (c) => {
        const renamed = c.previousLabel !== c.label ? ` (was "${c.previousLabel}")` : "";
        const parts = [
          c.addedNodeCount > 0 ? `+${c.addedNodeCount} nodes` : "",
          c.removedNodeCount > 0 ? `-${c.removedNodeCount} nodes` : "",
          c.editedNodeCount > 0 ? `${c.editedNodeCount} edited` : "",
        ].filter(Boolean);
        return `- "${c.label}"${renamed}: ${parts.join(", ") || "reorganized"}`;
      }),
    );
  }
  if (connections.added.length > 0 || connections.removed.length > 0) {
    lines.push(`Connections: +${connections.added.length} / -${connections.removed.length}`);
    lines.push(...capped(connections.added, (line) => `- new: ${line}`));
    lines.push(...capped(connections.removed, (line) => `- removed: ${line}`));
  }
  for (const block of nodes.blocks) {
    if (block.total === 0) continue;
    lines.push(`${block.title} (${block.total}):`, ...block.shown.map(nodeChangeLine));
    if (block.total > block.shown.length) lines.push(`- … and ${block.total - block.shown.length} more`);
  }
  // A new or removed table is one line among the nodes, not one per cell.
  const baselineTables = new Map(baseline.nodes.filter((node) => node.table).map((node) => [node.id, node]));
  const currentTables = new Map(current.nodes.filter((node) => node.table).map((node) => [node.id, node]));
  const cells = tableCells.filter((change) => baselineTables.has(change.tableNodeId) && currentTables.has(change.tableNodeId));
  if (cells.length > 0) {
    lines.push(`Table cells (${cells.length}):`,
      ...cells.slice(0, NODE_LINES_PER_BLOCK).map((change) => tableCellLine(current, currentTables.get(change.tableNodeId)!, change)));
    if (cells.length > NODE_LINES_PER_BLOCK) lines.push(`- … and ${cells.length - NODE_LINES_PER_BLOCK} more`);
  }
  lines.push(
    `Nodes: +${stats.addedNodes} added / -${stats.removedNodes} removed / ${stats.editedNodes} edited.`,
  );
  if (stats.unchangedClusters > 0) {
    lines.push(`Unchanged clusters: ${stats.unchangedClusters}.`);
  }

  return lines.join("\n");
}

/** "- sticky 5:87 in "Section": "old" → "new"". */
function nodeChangeLine({ change, before, after, board }: NodeChangeItem): string {
  const node = (after ?? before)!;
  const head = `- ${nodeLabel(board, node, change.name)}: `;
  if (change.changeType !== "edited") {
    const text = change.currentText ?? change.previousText;
    return head + (text !== undefined ? quote(text) : node.imageRef ? "image" : "no text");
  }
  const parts: string[] = [];
  for (const aspect of change.changes ?? []) {
    if (aspect === "text") {
      parts.push(collapseWhitespace(before!.text) === collapseWhitespace(after!.text)
        ? `text changed only in whitespace: ${quote(change.currentText ?? "")}`
        : `${quoteOrNone(change.previousText)} → ${quoteOrNone(change.currentText)}`);
    } else if (aspect === "name" && change.previousName !== undefined) {
      parts.push(`renamed ${quote(change.previousName)} → ${quote(change.name ?? "")}`);
    } else if (aspect === "image") {
      parts.push(before!.imageRef && after!.imageRef ? "image replaced" : after!.imageRef ? "image added" : "image removed");
    } else if (aspect === "rotation") {
      parts.push("rotated");
    } else if (aspect === "type") {
      parts.push(`type changed from ${readableType(before!)} to ${readableType(after!)}`);
    } else if (aspect === "appearance") {
      parts.push("appearance changed (color, size or style)");
    }
  }
  return head + parts.join("; ");
}

/** "- table "Name" 5:119 in "Section", row 3 "Label", column 4 "Label": "old" → "new"", rows and columns from 1. */
function tableCellLine(board: BoardData, table: NormalizedNode, change: TableCellChange): string {
  const row = change.currentRow ?? change.previousRow;
  const column = change.currentColumn ?? change.previousColumn;
  const labelled = (label: string | undefined) => label ? ` ${quote(label)}` : "";
  const place = row === undefined && column === undefined ? `, cell ${change.cellId}` :
    (row === undefined ? "" : `, row ${row + 1}${labelled(change.rowLabel)}`) +
    (column === undefined ? "" : `, column ${column + 1}${labelled(change.columnLabel)}`);
  const before = collapseWhitespace(change.previousText);
  const after = collapseWhitespace(change.currentText);
  const cellText = (text: string | undefined) => text === undefined ? "(empty)" : quote(text);
  let detail: string;
  if (change.changeType === "added") detail = `added ${cellText(after === undefined ? undefined : leadingText(after))}`;
  else if (change.changeType === "removed") detail = `removed ${cellText(before === undefined ? undefined : leadingText(before))}`;
  else if (change.previousText === change.currentText) {
    detail = `moved from row ${(change.previousRow ?? 0) + 1}, column ${(change.previousColumn ?? 0) + 1}`;
  } else if (before === after) detail = `text changed only in whitespace: ${cellText(after)}`;
  else {
    const [previous, next] = textExcerpts(before, after);
    detail = `${cellText(previous)} → ${cellText(next)}`;
  }
  return `- ${nodeLabel(board, table, change.tableName)}${place}: ${detail}`;
}

/** "sticky 5:87 in "Section"", with the name after the type when given. */
function nodeLabel(board: BoardData, node: NormalizedNode, name: string | undefined): string {
  const { sectionId, section } = sectionOf(board, node);
  const place = section ? `in ${quote(section)}` : sectionId ? `in section ${sectionId}` : "outside sections";
  return `${readableType(node)}${name ? ` ${quote(name)}` : ""} ${node.id} ${place}`;
}

/** sticky, text, shape, table, image, …; Figma's type in lower case otherwise. */
function readableType(node: NormalizedNode): string {
  if (node.type === "RECTANGLE" && node.imageRef) return "image";
  return READABLE_TYPES[node.type] ?? node.type.toLowerCase().replace(/_/g, " ");
}

function quote(text: string): string {
  return `"${text}"`;
}

function quoteOrNone(text: string | undefined): string {
  return text === undefined ? "(no text)" : quote(text);
}

function capped<T>(items: T[], render: (item: T) => string): string[] {
  const lines = items.slice(0, SUMMARY_SECTION_LIMIT).map(render);
  if (items.length > SUMMARY_SECTION_LIMIT) {
    lines.push(`- … and ${items.length - SUMMARY_SECTION_LIMIT} more`);
  }
  return lines;
}

function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function firstSentence(text: string): string {
  return text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
