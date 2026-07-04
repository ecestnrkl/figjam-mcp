import type { NormalizedNode } from "../types.js";

/**
 * Walks the raw Figma file JSON returned by figmaApi.ts#fetchFileTree and
 * flattens the nested "document" node tree into a flat list of
 * NormalizedNode, pulling out absolute position/size and any text content
 * needed for spatialCluster.ts.
 */
export function flattenNodeTree(rawFigmaJson: unknown): NormalizedNode[] {
  // TODO: implement — siehe Folge-Prompt
  throw new Error("Not implemented");
}
