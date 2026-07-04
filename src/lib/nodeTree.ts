import type { NormalizedNode } from "../types.js";

interface RawFigmaNode {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  rotation?: number;
  characters?: string;
  fills?: Array<{ type?: string; imageRef?: string }>;
  children?: RawFigmaNode[];
}

/** Container types that carry no content of their own — only their children do. */
const STRUCTURAL_TYPES = new Set(["DOCUMENT", "CANVAS", "PAGE", "FRAME", "GROUP", "SECTION"]);

function isRawFigmaNode(value: unknown): value is RawFigmaNode {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.type === "string"
  );
}

/** Returns the imageRef of the first image fill, if the node has one. */
function extractImageRef(node: RawFigmaNode): string | undefined {
  return node.fills?.find((fill) => fill.type === "IMAGE" && fill.imageRef)?.imageRef;
}

/** True if the node itself carries content (non-empty text or an image fill). */
function hasOwnContent(node: RawFigmaNode): boolean {
  return Boolean(node.characters?.trim()) || extractImageRef(node) !== undefined;
}

/**
 * Walks the raw Figma file JSON returned by figmaApi.ts#fetchFileTree and
 * flattens the nested "document" node tree into a flat list of
 * NormalizedNode, pulling out absolute position/size, rotation (in whatever
 * unit Figma reports), image fill refs, and any text content needed for
 * spatialCluster.ts.
 *
 * Empty structural nodes (frames/groups/sections with no text, no image
 * fill, and no contentful descendants) are dropped — they add noise but no
 * meaning. Structural nodes that DO contain content are kept (with a zeroed
 * bounding box for document/canvas, since Figma doesn't report one) so
 * parentId chains stay intact.
 */
export function flattenNodeTree(rawFigmaJson: unknown): NormalizedNode[] {
  const document = (rawFigmaJson as { document?: unknown } | null)?.document;

  if (!isRawFigmaNode(document)) {
    throw new Error(
      "flattenNodeTree: expected a Figma file response with a document node",
    );
  }

  const result: NormalizedNode[] = [];

  /**
   * Post-order visit: children are processed first so a structural node can
   * decide whether to keep itself based on whether any descendant
   * contributed content. Returns true if this subtree was kept.
   */
  function visit(node: RawFigmaNode, parentId: string | undefined): boolean {
    const childEntries: NormalizedNode[] = [];
    const before = result.length;

    let childrenHaveContent = false;
    for (const child of node.children ?? []) {
      childrenHaveContent = visit(child, node.id) || childrenHaveContent;
    }
    childEntries.push(...result.splice(before));

    const ownContent = hasOwnContent(node);
    const isStructural = STRUCTURAL_TYPES.has(node.type);

    // Structural nodes are only worth keeping when something inside (or on)
    // them carries content; everything else (stickies, shapes, text,
    // connectors, widgets, …) is real board content and always kept — and
    // counts as content for its ancestors, so a group holding only a bare
    // shape survives too.
    const keep = !isStructural || ownContent || childrenHaveContent;

    if (keep) {
      const box = node.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
      result.push({
        id: node.id,
        name: node.name,
        type: node.type,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        rotation: node.rotation ?? 0,
        imageRef: extractImageRef(node),
        text: node.characters,
        parentId,
      });
      result.push(...childEntries);
    }

    return keep;
  }

  for (const child of document.children ?? []) {
    visit(child, document.id);
  }

  return result;
}
