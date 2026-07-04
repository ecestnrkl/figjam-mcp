/**
 * Shared domain types for figjam-context-mcp.
 * No behavior lives here — just the shapes passed between lib modules.
 */

export type DocStructureHint = "double_diamond" | "freeform";
export type IngestMode = "balanced" | "max_quality" | "max_speed";
export type SummarySource = "vision_llm" | "text_llm" | "deterministic" | "cache";

export type DoubleDiamondPhase =
  | "discover"
  | "define"
  | "develop"
  | "deliver"
  | "unclear";

/** A single Figma/FigJam node, flattened out of the nested API tree. */
export interface NormalizedNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation as reported by the Figma API (0 when absent). */
  rotation: number;
  /** Reference to an image fill, when the node contains a bitmap. */
  imageRef?: string;
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
  /** 3–5 sentence summary; image content descriptions are folded in here. */
  summary: string;
  /**
   * Node IDs the vision model confirmed as thematically belonging together.
   * May be a subset of Cluster.nodeIds if the model dropped members.
   */
  confirmedNodeIds: string[];
  phase?: DoubleDiamondPhase;
  summarySource?: SummarySource;
  modelId?: string;
}

export interface IngestQualityReport {
  modelsUsed: string[];
  cachedClusters: number;
  deterministicClusters: number;
  visionClusters: number;
  fallbackCount: number;
}

/** Everything ingest_board produces and later tools read back via cache.ts. */
export interface BoardData {
  boardId: string;
  fileKey: string;
  docStructureHint: DocStructureHint;
  ingestMode?: IngestMode;
  cacheKey?: string;
  figmaLastModified?: string;
  nodeHash?: string;
  modelPreset?: string;
  qualityReport?: IngestQualityReport;
  nodes: NormalizedNode[];
  clusters: RefinedCluster[];
  createdAt: number;
}
