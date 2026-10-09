import { createHash } from "node:crypto";
import type { NormalizedNode, TableCell } from "../types.js";

interface RawFigmaNode {
  [key: string]: unknown;
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  rotation?: number;
  characters?: string;
  fills?: Array<{ type?: string; imageRef?: string }>;
  connectorStart?: { endpointNodeId?: string };
  connectorEnd?: { endpointNodeId?: string };
  connectorStartStrokeCap?: string;
  connectorEndStrokeCap?: string;
  children?: RawFigmaNode[];
}

export const STRUCTURAL_TYPES = new Set(["DOCUMENT", "CANVAS", "PAGE", "FRAME", "GROUP", "SECTION"]);
export const MAX_BOARD_NODES = 100_000;
const MAX_BOARD_DEPTH = 1024;
const MAX_METADATA_DEPTH = 64;

function validateGeometry(node: RawFigmaNode): void {
  const box = node.absoluteBoundingBox;
  if ((box && (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 0 || box.height < 0)) ||
      (node.rotation !== undefined && !Number.isFinite(node.rotation))) {
    throw new Error(`Board element ${node.id} has invalid geometry: positions and dimensions must be finite and sizes cannot be negative.`);
  }
}

/** Bounds arbitrary paint/vector metadata before JSON's recursive serializer. */
function validateMetadataDepth(content: Record<string, unknown>, nodeId: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: content, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (depth > MAX_METADATA_DEPTH) {
      throw new Error(`Board element ${nodeId} contains metadata deeper than ${MAX_METADATA_DEPTH} levels. Simplify the element before ingesting it.`);
    }
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
    }
  }
}

function isRawFigmaNode(value: unknown): value is RawFigmaNode {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.name === "string" &&
    typeof candidate.type === "string";
}

function extractImageRef(node: RawFigmaNode): string | undefined {
  return node.fills?.find((fill) => fill.type === "IMAGE" && fill.imageRef)?.imageRef;
}

/** Placement does not invalidate a summary; paint, shape and original text do. */
function fingerprint(node: RawFigmaNode, childFingerprints: string[] = []): string {
  const omitted = new Set([
    "id", "children", "absoluteBoundingBox", "absoluteRenderBounds", "relativeTransform",
    "absoluteTransform", "rotation", "x", "y",
  ]);
  const content: Record<string, unknown> = {};
  for (const key of Object.keys(node).sort()) {
    if (!omitted.has(key)) content[key] = node[key];
  }
  content.size = node.absoluteBoundingBox && {
    width: node.absoluteBoundingBox.width, height: node.absoluteBoundingBox.height,
  };
  if (childFingerprints.length > 0) content.children = childFingerprints;
  validateMetadataDepth(content, node.id);
  const serialized = JSON.stringify(content, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
  return createHash("sha256").update(serialized).digest("hex");
}

interface Entry {
  raw: RawFigmaNode;
  parent?: number;
  parentId: string;
  pageId?: string;
  sectionIds: string[];
  tableOwner?: number;
  depth: number;
  keep: boolean;
  children: number[];
  contentFingerprint?: string;
}

function cellText(entry: Entry, entries: Entry[]): string {
  if (entry.raw.characters !== undefined) return entry.raw.characters;
  const snippets: string[] = [];
  const stack = [...entry.children].reverse();
  while (stack.length > 0) {
    const child = entries[stack.pop()!]!;
    if (child.raw.characters !== undefined) {
      snippets.push(child.raw.characters);
    } else {
      for (let i = child.children.length - 1; i >= 0; i--) stack.push(child.children[i]!);
    }
  }
  return snippets.join("\n");
}

/**
 * Iterative traversal preserves document order without recursive calls or wide
 * argument spreads. Table cells remain original evidence on their parent TABLE;
 * only the table's normal node ID is eligible for rendering and clustering.
 */
export function flattenNodeTree(rawFigmaJson: unknown): NormalizedNode[] {
  const document = (rawFigmaJson as { document?: unknown } | null)?.document;
  if (!isRawFigmaNode(document)) {
    throw new Error("flattenNodeTree: expected a Figma file response with a document node");
  }

  const entries: Entry[] = [];
  const roots = document.children ?? [];
  if (roots.length > MAX_BOARD_NODES) throw new Error(`Board exceeds the ${MAX_BOARD_NODES}-node limit`);
  const stack: Array<{ raw: RawFigmaNode; parent?: number }> = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ raw: roots[i]! });
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (!isRawFigmaNode(item.raw)) throw new Error("flattenNodeTree: invalid child node");
    validateGeometry(item.raw);
    if (entries.length >= MAX_BOARD_NODES) throw new Error(`Board exceeds the ${MAX_BOARD_NODES}-node limit`);
    const parent = item.parent === undefined ? undefined : entries[item.parent]!;
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > MAX_BOARD_DEPTH) throw new Error(`Board exceeds the ${MAX_BOARD_DEPTH}-level nesting limit`);
    const { raw } = item;
    const index = entries.length;
    const sectionIds = raw.type === "SECTION" ? [...(parent?.sectionIds ?? []), raw.id] : parent?.sectionIds ?? [];
    const entry: Entry = {
      raw, parent: item.parent, parentId: parent?.raw.id ?? document.id,
      pageId: raw.type === "CANVAS" || raw.type === "PAGE" ? raw.id : parent?.pageId,
      sectionIds, depth, children: [],
      tableOwner: parent?.raw.type === "TABLE" ? item.parent : parent?.tableOwner,
      keep: !STRUCTURAL_TYPES.has(raw.type) || Boolean(raw.characters?.trim()) || Boolean(extractImageRef(raw)),
    };
    entries.push(entry);
    parent?.children.push(index);
    const children = raw.children ?? [];
    if (entries.length + stack.length + children.length > MAX_BOARD_NODES) {
      throw new Error(`Board exceeds the ${MAX_BOARD_NODES}-node limit`);
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push({ raw: children[i]!, parent: index });
  }

  const cellsByTable = new Map<number, TableCell[]>();
  // Hash table descendants bottom-up, so non-text visual edits also invalidate reuse.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const includeChildren = entry.raw.type === "TABLE" || entry.tableOwner !== undefined;
    entry.contentFingerprint = fingerprint(entry.raw, includeChildren
      ? entry.children.map((child) => entries[child]!.contentFingerprint!) : []);
    if (entry.keep && entry.parent !== undefined) entries[entry.parent]!.keep = true;
  }
  for (const entry of entries) {
    if (entry.tableOwner === undefined || entry.raw.type !== "TABLE_CELL") continue;
    const cell: TableCell = { id: entry.raw.id, text: cellText(entry, entries) };
    // Only report positions explicitly present in the source; IDs are opaque.
    if (Number.isInteger(entry.raw.rowIndex) && Number(entry.raw.rowIndex) >= 0) cell.row = Number(entry.raw.rowIndex);
    if (Number.isInteger(entry.raw.columnIndex) && Number(entry.raw.columnIndex) >= 0) cell.column = Number(entry.raw.columnIndex);
    const cells = cellsByTable.get(entry.tableOwner) ?? [];
    cells.push(cell);
    cellsByTable.set(entry.tableOwner, cells);
  }

  const result: NormalizedNode[] = [];
  entries.forEach((entry, index) => {
    if (!entry.keep || entry.tableOwner !== undefined) return;
    const node = entry.raw;
    const box = node.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
    const cells = node.type === "TABLE" ? cellsByTable.get(index) ?? [] : undefined;
    result.push({
      id: node.id, name: node.name, type: node.type,
      x: box.x, y: box.y, width: box.width, height: box.height,
      rotation: node.rotation ?? 0, imageRef: extractImageRef(node),
      text: cells ? [node.characters, ...cells.map((cell) => cell.text)].filter((text) => text !== undefined && text !== "").join("\n") : node.characters,
      parentId: entry.parentId, pageId: entry.pageId, sectionIds: entry.sectionIds,
      renderNodeId: node.id, table: cells ? { cells } : undefined,
      contentFingerprint: entry.contentFingerprint,
      connectorStartId: node.connectorStart?.endpointNodeId,
      connectorEndId: node.connectorEnd?.endpointNodeId,
      connectorStartArrowhead: node.connectorStartStrokeCap,
      connectorEndArrowhead: node.connectorEndStrokeCap,
    });
  });
  return result;
}
