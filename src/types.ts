/**
 * Shared domain types for figjam-context-mcp.
 * No behavior lives here — just the shapes passed between lib modules.
 */

export type DocStructureHint = "double_diamond" | "freeform";

export type DoubleDiamondPhase = "discover" | "define" | "develop" | "deliver";

/** A single Figma/FigJam node, flattened out of the nested API tree. */
export interface NormalizedNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  parentId?: string;
}

/** A purely geometric grouping of nodes, before any semantic refinement. */
export interface Cluster {
  id: string;
  nodeIds: string[];
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/** A Cluster enriched with a human-readable label/summary via vision analysis. */
export interface RefinedCluster extends Cluster {
  label: string;
  summary: string;
  describedContent?: string;
  phase?: DoubleDiamondPhase;
}

/** Everything ingest_board produces and later tools read back via cache.ts. */
export interface BoardData {
  boardId: string;
  fileKey: string;
  docStructureHint: DocStructureHint;
  nodes: NormalizedNode[];
  clusters: RefinedCluster[];
  createdAt: number;
}
