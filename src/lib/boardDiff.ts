import type { BoardData, ConnectorEdge, NormalizedNode, RefinedCluster, TableCell } from "../types.js";
import { isGenericNodeName, STRUCTURAL_TYPES } from "./nodeTree.js";
import { hashClusterNodes } from "./persistentCache.js";
import { connectorArrow } from "./connectorGraph.js";
import { boundedText, nodeLink, snapshotIdForBoard, tableCellPositions } from "./evidence.js";

/**
 * Compares two ingest snapshots of the same board — "what changed since the
 * last workshop?". Works on three levels:
 *  - nodes: added / removed / edited content nodes (structural containers
 *    and connectors excluded — connectors are diffed separately),
 *    and named with their section and old and new text,
 *  - clusters: matched across snapshots by member overlap, then classified
 *    as unchanged (same content hash), modified, new, or removed,
 *  - connections: connector arrows diffed as (from, to, label) edges and
 *    rendered with arrow and endpoint IDs and endpoint text.
 */

export interface ClusterSummaryRef {
  label: string;
  summary: string;
  /** Innermost section shared by the members, by name; absent outside sections. */
  section?: string;
}

export interface ModifiedClusterDiff {
  label: string;
  previousLabel: string;
  /** Innermost section of the current cluster, by name; absent outside sections. */
  section?: string;
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
  newClustersOmitted?: number;
  removedClustersOmitted?: number;
  modifiedClustersOmitted?: number;
  addedConnectionsOmitted?: number;
  removedConnectionsOmitted?: number;
  tableCellChangesOmitted?: number;
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
const CLUSTER_LIMIT = 20;
const CONNECTION_LIMIT = 50;
const TABLE_CELL_LIMIT = 50;
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
  const previousSections = new Map(baseline.nodes.filter((node) => node.type === "SECTION").map((node) => [node.id, node]));
  const currentSections = new Map(current.nodes.filter((node) => node.type === "SECTION").map((node) => [node.id, node]));
  const visibilityChanges = [...currentSections.values()].flatMap((node) => {
    const previous = previousSections.get(node.id);
    if (!previous || Boolean(previous.hiddenDescendantIds) === Boolean(node.hiddenDescendantIds)) return [];
    return [{ id: node.id, hidden: Boolean(node.hiddenDescendantIds) }];
  });
  if (visibilityChanges.length) {
    const changed = new Set(visibilityChanges.map((change) => change.id));
    const filter = (board: BoardData): BoardData => {
      const removed = new Set(board.nodes.filter((node) => node.sectionIds?.some((id) => changed.has(id) && id !== node.id)).map((node) => node.id));
      const clusters = board.clusters.filter((cluster) => !cluster.nodeIds.some((id) => removed.has(id)));
      return { ...board, nodes: board.nodes.filter((node) => !removed.has(node.id)), clusters,
        connectorEdges: board.connectorEdges?.filter((edge) => !removed.has(edge.connectorId) && !removed.has(edge.fromNodeId) && !removed.has(edge.toNodeId)) };
    };
    baseline = filter(baseline);
    current = filter(current);
  }
  // Fingerprint algorithms change with extraction rules. Compare stored evidence
  // across versions without treating the algorithm change as a visual edit.
  if ((baseline.extractionVersion ?? 4) !== (current.extractionVersion ?? 4)) {
    const withoutFingerprints = (board: BoardData): BoardData => ({
      ...board, nodes: board.nodes.map((node) => ({ ...node, contentFingerprint: undefined })),
    });
    baseline = withoutFingerprints(baseline);
    current = withoutFingerprints(current);
  }
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
    newClusters: clusterDiff.newClusters.slice(0, CLUSTER_LIMIT),
    removedClusters: clusterDiff.removedClusters.slice(0, CLUSTER_LIMIT),
    modifiedClusters: clusterDiff.modifiedClusters.slice(0, CLUSTER_LIMIT),
    addedConnections: connectionDiff.added.slice(0, CONNECTION_LIMIT),
    removedConnections: connectionDiff.removed.slice(0, CONNECTION_LIMIT),
    summaryText: buildSummaryText(baseline, current, stats, clusterDiff, connectionDiff, nodeDiff, tableCellChanges) +
      visibilityChanges.map((change) => `\n\nSection ${change.id}: contents ${change.hidden ? "hidden" : "shown"} in FigJam.`).join(""),
    tableCellChanges: tableCellChanges.slice(0, TABLE_CELL_LIMIT).map((change) => {
      const [previousText, currentText] = textExcerpts(collapseWhitespace(change.previousText), collapseWhitespace(change.currentText));
      return { ...change, previousText, currentText };
    }),
    nodeChanges: nodeDiff.entries,
    ...(nodeDiff.omitted > 0 ? { nodeChangesOmitted: nodeDiff.omitted } : {}),
    ...(clusterDiff.newClusters.length > CLUSTER_LIMIT ? { newClustersOmitted: clusterDiff.newClusters.length - CLUSTER_LIMIT } : {}),
    ...(clusterDiff.removedClusters.length > CLUSTER_LIMIT ? { removedClustersOmitted: clusterDiff.removedClusters.length - CLUSTER_LIMIT } : {}),
    ...(clusterDiff.modifiedClusters.length > CLUSTER_LIMIT ? { modifiedClustersOmitted: clusterDiff.modifiedClusters.length - CLUSTER_LIMIT } : {}),
    ...(connectionDiff.added.length > CONNECTION_LIMIT ? { addedConnectionsOmitted: connectionDiff.added.length - CONNECTION_LIMIT } : {}),
    ...(connectionDiff.removed.length > CONNECTION_LIMIT ? { removedConnectionsOmitted: connectionDiff.removed.length - CONNECTION_LIMIT } : {}),
    ...(tableCellChanges.length > TABLE_CELL_LIMIT ? { tableCellChangesOmitted: tableCellChanges.length - TABLE_CELL_LIMIT } : {}),
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
  cellOnlyTables: number;
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
    cellOnlyTables: editedIds.length - groups[0]!.ids.length,
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
 * Both texts whole up to FULL_TEXT_CHARS, and their leading text when they are equal.
 * Otherwise only the changed words on each side, with up to EDIT_CONTEXT_CHARS of
 * context before and after, cut at word boundaries and marked with "…", at most
 * EDIT_EXCERPT_CHARS per side.
 */
function textExcerpts(before: string | undefined, after: string | undefined): [string | undefined, string | undefined] {
  if (before === undefined || after === undefined || before === after) {
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
      ...clusterSection(cur, currentNodesById),
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
      .map((cluster) => ({ label: cluster.label, summary: cluster.summary, ...clusterSection(cluster, currentNodesById) })),
    removedClusters: baseline.clusters
      .filter((cluster) => !matchedPrev.has(cluster.id))
      .map((cluster) => ({ label: cluster.label, summary: cluster.summary, ...clusterSection(cluster, baselineNodesById) })),
    modifiedClusters,
    unchangedClusters,
  };
}

/** The named innermost section all members of a cluster share. */
function clusterSection(cluster: RefinedCluster, nodesById: Map<string, NormalizedNode>): { section?: string } {
  const ids = new Set(membersOf(cluster, nodesById).map((node) => node.sectionIds?.at(-1)));
  const [id] = ids;
  const section = ids.size === 1 && id ? collapseWhitespace(nodesById.get(id)?.name) : undefined;
  return section ? { section: boundedText(section, NAME_CHARS) } : {};
}

/** " in "Section"" unless the label starts with the section's name, also cut short as in "Long section…: text". */
function clusterPlace(label: string, section: string | undefined): string {
  if (!section) return "";
  const name = section.replace(/…$/, "");
  const prefix = label.split(/…|\.\.\./)[0]!;
  const named = label.startsWith(name) || (prefix.length > 0 && prefix.length < label.length && name.startsWith(prefix));
  return named ? "" : ` in ${quote(section)}`;
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

/** Renders one arrow and its endpoints from its own snapshot, as get_board_context names them. */
function edgeFormatter(board: BoardData): (edge: ConnectorEdge) => string {
  const nodes = new Map(board.nodes.map(node => [node.id, node]));
  return edge => {
    const label = (id: string) => {
      const node = nodes.get(id);
      const text = collapseWhitespace(node?.text) ?? collapseWhitespace(node?.name);
      return text ? `${id} «${boundedText(text, 40)}»` : id;
    };
    return `arrow ${edge.connectorId}: ${label(edge.fromNodeId)} ${connectorArrow(edge)} ${label(edge.toNodeId)}${edge.label ? ` (${edge.label})` : ""}`;
  };
}

/** Existing sections and frames can be renamed without changing any content node. */
function renamedSections(baseline: BoardData, current: BoardData): string[] {
  const previous = new Map(baseline.nodes.map((node) => [node.id, node]));
  return current.nodes.flatMap((node) => {
    const before = previous.get(node.id);
    return (node.type === "SECTION" || node.type === "FRAME") && before?.type === node.type && before.name !== node.name
      ? [`- ${readableType(node)} ${node.id}: ${quote(boundedName(before.name))} → ${quote(boundedName(node.name))}`]
      : [];
  });
}

/** Count placement changes only; added, removed and content-edited nodes are described elsewhere. */
function layoutChangeCount(baseline: BoardData, current: BoardData): number {
  const previous = new Map(baseline.nodes.map((node) => [node.id, node]));
  return current.nodes.filter((node) => {
    const before = previous.get(node.id);
    if (node.type === "CONNECTOR" || !before) return false;
    const resized = before.width !== node.width || before.height !== node.height;
    // Extraction includes dimensions in the appearance fingerprint. A resize
    // alone can change it, while the existing content/cluster classification stays intact.
    const sameContent = resized
      ? !nodeContentChanged({ ...before, contentFingerprint: undefined }, { ...node, contentFingerprint: undefined })
      : !nodeContentChanged(before, node);
    return sameContent && (resized || before.x !== node.x || before.y !== node.y);
  }).length;
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
    `FigJam board ${current.fileKey} — changes from ${timestamp(baseline.createdAt)} (snapshot ${snapshotIdForBoard(baseline)}) to ${timestamp(current.createdAt)} (snapshot ${snapshotIdForBoard(current)}):`,
    "",
  ];
  const renames = renamedSections(baseline, current);
  const layoutChanges = layoutChangeCount(baseline, current);

  if (
    stats.addedNodes + stats.removedNodes + stats.editedNodes === 0 &&
    stats.newClusters + stats.removedClusters + stats.modifiedClusters === 0 &&
    stats.addedConnections + stats.removedConnections === 0 &&
    renames.length === 0 && layoutChanges === 0
  ) {
    lines.push(snapshotIdForBoard(baseline) === snapshotIdForBoard(current)
      ? "No changes — the board content is identical."
      : "No content, name or layout changes found; the snapshots differ only in details diff_board does not compare.");
    return lines.join("\n");
  }

  if (renames.length > 0) lines.push(`Renamed sections (${renames.length}):`, ...capped(renames, (line) => line));
  if (layoutChanges > 0) lines.push(`Layout: ${layoutChanges} node${layoutChanges === 1 ? "" : "s"} moved or resized.`);

  if (clusters.newClusters.length > 0) {
    lines.push(`New clusters (${clusters.newClusters.length}):`);
    lines.push(
      ...capped(clusters.newClusters, (c) => `- "${c.label}"${clusterPlace(c.label, c.section)}: ${firstSentence(c.summary)}`),
    );
  }
  if (clusters.removedClusters.length > 0) {
    lines.push(`Removed clusters (${clusters.removedClusters.length}):`);
    lines.push(...capped(clusters.removedClusters, (c) => `- "${c.label}"${clusterPlace(c.label, c.section)}`));
  }
  if (clusters.modifiedClusters.length > 0) {
    lines.push(`Modified clusters (${clusters.modifiedClusters.length}):`);
    lines.push(
      ...capped(clusters.modifiedClusters, (c) => {
        const renamed = c.previousLabel !== c.label ? ` (was "${c.previousLabel}")` : "";
        const parts = [
          c.addedNodeCount > 0 ? `+${c.addedNodeCount} node${c.addedNodeCount === 1 ? "" : "s"}` : "",
          c.removedNodeCount > 0 ? `-${c.removedNodeCount} node${c.removedNodeCount === 1 ? "" : "s"}` : "",
          c.editedNodeCount > 0 ? `${c.editedNodeCount} edited` : "",
        ].filter(Boolean);
        return `- "${c.label}"${renamed}${clusterPlace(c.label, c.section)}: ${parts.join(", ") || "reorganized"}`;
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
    `Nodes: +${stats.addedNodes} added / -${stats.removedNodes} removed / ${stats.editedNodes} edited` +
      (nodes.cellOnlyTables > 0 ? ` (${nodes.cellOnlyTables} of them ${nodes.cellOnlyTables === 1 ? "a table" : "tables"} with cell changes, listed under Table cells).` : "."),
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

/** "- table "Name" 5:119 in "Section", row 2 "Label", column 3 "Label": "old" → "new"", rows and columns from 0. */
function tableCellLine(board: BoardData, table: NormalizedNode, change: TableCellChange): string {
  const row = change.currentRow ?? change.previousRow;
  const column = change.currentColumn ?? change.previousColumn;
  const labelled = (label: string | undefined) => label ? ` ${quote(label)}` : "";
  const place = row === undefined && column === undefined ? `, cell ${change.cellId}` :
    (row === undefined ? "" : `, row ${row}${labelled(change.rowLabel)}`) +
    (column === undefined ? "" : `, column ${column}${labelled(change.columnLabel)}`);
  const before = collapseWhitespace(change.previousText);
  const after = collapseWhitespace(change.currentText);
  const cellText = (text: string | undefined) => text === undefined ? "(empty)" : quote(text);
  let detail: string;
  if (change.changeType === "added") detail = `added ${cellText(after === undefined ? undefined : leadingText(after))}`;
  else if (change.changeType === "removed") detail = `removed ${cellText(before === undefined ? undefined : leadingText(before))}`;
  else if (change.previousText === change.currentText) {
    detail = `moved from row ${change.previousRow ?? 0}, column ${change.previousColumn ?? 0}`;
  } else if (before === after) {
    detail = `text changed only in whitespace: ${cellText(after === undefined ? undefined : leadingText(after))}`;
  } else {
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
