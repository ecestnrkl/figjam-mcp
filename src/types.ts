/**
 * Shared domain types for figjam-context-mcp.
 * No behavior lives here — just the shapes passed between lib modules.
 */

export type DocStructureHint =
  | "freeform"
  | "double_diamond"
  | "lean_canvas"
  | "retro"
  | "user_journey";
export type IngestMode = "balanced" | "max_quality" | "max_speed";
export type SummarySource = "vision_llm" | "text_llm" | "deterministic" | "cache";

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
  /** For CONNECTOR nodes: the node id the arrow starts at, if attached. */
  connectorStartId?: string;
  /** For CONNECTOR nodes: the node id the arrow points to, if attached. */
  connectorEndId?: string;
}

/** One connector arrow between two board nodes, with its optional label. */
export interface ConnectorEdge {
  connectorId: string;
  fromNodeId: string;
  toNodeId: string;
  /** Text written on the connector itself (e.g. "leads to"). */
  label?: string;
}

/**
 * Aggregated connector edges between two clusters — the board's semantic
 * structure ("this group feeds into that one"), derived from arrows.
 */
export interface ClusterRelation {
  fromClusterId: string;
  toClusterId: string;
  /** Unique non-empty connector labels between the two clusters. */
  labels: string[];
  edgeCount: number;
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
  /** Phase name from the active doc-structure framework, or "unclear". */
  phase?: string;
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
  /** User-defined phase names; overrides docStructureHint when present. */
  customPhases?: string[];
  ingestMode?: IngestMode;
  cacheKey?: string;
  figmaLastModified?: string;
  nodeHash?: string;
  modelPreset?: string;
  qualityReport?: IngestQualityReport;
  nodes: NormalizedNode[];
  clusters: RefinedCluster[];
  /** All connector arrows found on the board (node-level). */
  connectorEdges?: ConnectorEdge[];
  /** Connector edges aggregated to directed cluster-to-cluster relations. */
  clusterRelations?: ClusterRelation[];
  createdAt: number;
}
