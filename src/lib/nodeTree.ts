import type { NormalizedNode } from "../types.js";

interface RawFigmaNode {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  characters?: string;
  children?: RawFigmaNode[];
}

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

/**
 * Walks the raw Figma file JSON returned by figmaApi.ts#fetchFileTree and
 * flattens the nested "document" node tree into a flat list of
 * NormalizedNode, pulling out absolute position/size and any text content
 * needed for spatialCluster.ts. The document/canvas nodes themselves are
 * included (with a zeroed bounding box, since Figma doesn't report one for
 * them) so parentId chains stay intact.
 */
export function flattenNodeTree(rawFigmaJson: unknown): NormalizedNode[] {
  const document = (rawFigmaJson as { document?: unknown } | null)?.document;

  if (!isRawFigmaNode(document)) {
    throw new Error(
      "flattenNodeTree: expected a Figma file response with a document node",
    );
  }

  const result: NormalizedNode[] = [];

  function visit(node: RawFigmaNode, parentId: string | undefined): void {
    const box = node.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };

    result.push({
      id: node.id,
      name: node.name,
      type: node.type,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      text: node.characters,
      parentId,
    });

    for (const child of node.children ?? []) {
      visit(child, node.id);
    }
  }

  for (const child of document.children ?? []) {
    visit(child, document.id);
  }

  return result;
}
