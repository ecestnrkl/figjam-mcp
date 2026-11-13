import type { NormalizedNode } from "../types.js";

type Bounds = Pick<NormalizedNode, "x" | "y" | "height">;

// Overlapping at least half the shorter item allows small offsets without joining barely touching rows.
const ROW_OVERLAP_RATIO = 0.5;

export function pagePositions(nodes: NormalizedNode[]): Map<string, number> {
  return new Map(nodes.filter((node) => node.type === "CANVAS" || node.type === "PAGE")
    .map((node, position) => [node.id, position]));
}

/** Page first, then row bands from top to bottom and their members from left to right. */
export function inReadingOrder<T>(
  items: T[], boundsOf: (item: T) => Bounds | undefined, pageOf: (item: T) => number = () => 0,
): T[] {
  if (items.length < 2) return items;
  const placed = items.map((item, position) => {
    const bounds = boundsOf(item);
    return { item, position, page: pageOf(item), x: bounds?.x ?? 0, y: bounds?.y ?? 0, height: Math.max(0, bounds?.height ?? 0) };
  }).sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x || a.position - b.position);
  const ordered: T[] = [];
  let band: typeof placed = [];
  let { page: rowPage, y: rowY, height: rowHeight } = placed[0]!;
  const emitBand = () => {
    band.sort((a, b) => a.x - b.x || a.position - b.position);
    for (const { item } of band) ordered.push(item);
  };
  for (const item of placed) {
    const offset = item.y - rowY;
    const overlap = Math.min(rowHeight - offset, item.height);
    const sameBand = item.page === rowPage && (offset === 0 ||
      (overlap > 0 && overlap >= ROW_OVERLAP_RATIO * Math.min(rowHeight, item.height)));
    if (!sameBand) {
      emitBand();
      band = [];
      rowPage = item.page;
      rowY = item.y;
      rowHeight = item.height;
    } else if (item.height > 0 && (rowHeight === 0 || item.height <= rowHeight)) {
      // Follow a sloping row without letting a taller item move the band down.
      rowY = item.y;
      rowHeight = item.height;
    }
    band.push(item);
  }
  emitBand();
  return ordered;
}

interface NodePosition {
  nodeId: string;
  bounds: Bounds | undefined;
  page: number;
  cluster?: { id: string; boundingBox: Bounds };
}

/** Read cluster bounds (or a single node's bounds), then the nodes inside each group. */
export function inClusterReadingOrder<T>(items: T[], locate: (item: T) => NodePosition): T[] {
  if (items.length < 2) return items;
  const groups = new Map<string, { bounds: Bounds | undefined; page: number; items: Array<{ value: T; bounds: Bounds | undefined }> }>();
  for (const value of items) {
    const { nodeId, bounds, page, cluster } = locate(value);
    const key = `${page}\0${cluster ? `cluster\0${cluster.id}` : `node\0${nodeId}`}`;
    const item = { value, bounds };
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { bounds: cluster?.boundingBox ?? bounds, page, items: [item] });
  }
  return inReadingOrder([...groups.values()], (group) => group.bounds, (group) => group.page)
    .flatMap((group) => inReadingOrder(group.items, (item) => item.bounds).map((item) => item.value));
}
