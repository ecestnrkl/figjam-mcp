import { createHash } from "node:crypto";
import type { NormalizedNode, Cluster } from "../types.js";

/**
 * Board-level entry point. Pages have independent coordinate systems and
 * sections are explicit author-owned boundaries, so geometric components must
 * never cross either. Cluster identity follows membership, not canvas order.
 */
export function partitionedBoardClusters(
  nodes: NormalizedNode[],
  options: GeometricClusterOptions = {},
): Cluster[] {
  const parentIds = new Set(nodes.map((node) => node.parentId).filter(Boolean));
  const partitions = new Map<string, NormalizedNode[]>();
  for (const node of nodes) {
    toFootprint(node); // Validate even excluded containers/zero-size entries.
    if (parentIds.has(node.id) || node.type === "CONNECTOR" ||
        (node.width <= 0 && node.height <= 0)) continue;
    const key = JSON.stringify([node.pageId ?? null, node.sectionIds?.at(-1) ?? null]);
    const members = partitions.get(key) ?? [];
    members.push(node);
    partitions.set(key, members);
  }
  const result: Cluster[] = [];
  const budget: SpatialWorkBudget = { comparisons: 0, gridEntries: 0 };
  for (const [partition, members] of [...partitions].sort(([a], [b]) => a.localeCompare(b))) {
    for (const cluster of clusterNodes(members, options, budget)) {
      const identity = JSON.stringify([partition, [...cluster.nodeIds].sort()]);
      cluster.id = `cluster_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
      result.push(cluster);
    }
  }
  return result;
}

/**
 * Maximum gap (in canvas px) between two nodes' footprints for them to be
 * considered part of the same cluster. FigJam stickies default to ~240 px,
 * so 160 px links neighboring stickies while keeping separate board areas
 * apart. Used when adaptive estimation has too little data to work with;
 * override via GeometricClusterOptions.gapThreshold.
 */
const DEFAULT_GAP_THRESHOLD = 160;

/** Minimum node count before the adaptive threshold estimate kicks in. */
const MIN_ADAPTIVE_NODES = 12;

/** Clamp range for the adaptive threshold (canvas px). */
const ADAPTIVE_MIN = 96;
const ADAPTIVE_MAX = 320;

/** Multiplier on the median nearest-neighbor gap (within-group spacing). */
const ADAPTIVE_FACTOR = 3;

/** Max nodes sampled for the nearest-neighbor median (keeps it cheap). */
const ADAPTIVE_SAMPLE_LIMIT = 150;

/** Prevents one transitive single-linkage chain from becoming an unbounded LLM unit. */
const DEFAULT_MAX_CLUSTER_SIZE = 250;

/**
 * A very large background shape can cover hundreds of thousands of grid cells.
 * Such footprints use a bounded pairwise overflow path instead of expanding
 * memory in proportion to canvas area.
 */
const DEFAULT_MAX_GRID_CELLS_PER_NODE = 4096;
const DEFAULT_MAX_GRID_ENTRIES = 1_000_000;
const DEFAULT_MAX_PAIR_COMPARISONS = 10_000_000;
const MAX_ADAPTIVE_COMPARISONS = 1_000_000;

export interface GeometricClusterOptions {
  /**
   * Max euclidean gap between node footprints to join a cluster (canvas px).
   * Setting this disables adaptive estimation.
   */
  gapThreshold?: number;
  /**
   * Derive the threshold from the board's own density (median
   * nearest-neighbor gap) instead of the fixed default. On by default;
   * only applies when no explicit gapThreshold is set and the board has at
   * least MIN_ADAPTIVE_NODES nodes.
   */
  adaptiveGapThreshold?: boolean;
  /** Maximum members in one returned cluster; larger groups are spatially bisected. */
  maxClusterSize?: number;
  /** Maximum spatial-hash cells occupied by one node before using the overflow path. */
  maxGridCellsPerNode?: number;
  /** Total footprint-to-cell entries allowed for the entire board partition. */
  maxGridEntries?: number;
  /** Hard work bound, including pairs already connected in the union-find. */
  maxPairComparisons?: number;
}

/** A node's spatial footprint used for distance checks. */
interface Footprint {
  node: NormalizedNode;
  centerX: number;
  centerY: number;
  /** Half-extent of a disc approximation; used for rotated nodes. */
  radius: number;
  rotated: boolean;
}

interface SpatialWorkBudget { comparisons: number; gridEntries: number }

/**
 * Groups NormalizedNode entries into spatial clusters purely by geometry
 * (single-linkage: a node joins a cluster if it is within the gap threshold
 * of ANY node already in it), before any vision-based refinement is applied
 * in visionInterpreter.ts. Connected components above maxClusterSize are
 * spatially bisected so one bridge/background node cannot create an unbounded
 * downstream LLM unit.
 *
 * Rotation handling: Figma reports `x/y/width/height` as the axis-aligned
 * bounding box (AABB), which over-approximates rotated nodes — a thin sticky
 * rotated 45° gets a much larger AABB, whose far corners could falsely
 * bridge two neighboring groups. For rotated nodes we therefore measure
 * distance against a disc centered on the AABB center (which is exactly the
 * rotated node's true center) with radius = mean AABB half-extent, a close
 * approximation of the rotated footprint. Non-rotated nodes keep the exact
 * rect-to-rect gap.
 *
 * Performance: instead of testing all O(n²) pairs, footprints are indexed
 * into a uniform grid (spatial hash). Each footprint's bounds — inflated by
 * half the gap threshold — are inserted into every cell they cover; two
 * footprints within the threshold necessarily share a cell, so only
 * cell-local pairs need the exact gap check. Footprints covering too many
 * cells use a bounded pairwise overflow path instead. This stays near-linear
 * on real boards and makes work depend on node count rather than canvas area.
 *
 * Returns coarse cluster candidates (IDs + bounding boxes only); labels and
 * summaries are added later by the vision step.
 */
export function geometricPreCluster(
  nodes: NormalizedNode[],
  options: GeometricClusterOptions = {},
): Cluster[] {
  return clusterNodes(nodes, options, { comparisons: 0, gridEntries: 0 });
}

function clusterNodes(
  nodes: NormalizedNode[],
  options: GeometricClusterOptions,
  budget: SpatialWorkBudget,
): Cluster[] {
  if (nodes.length === 0) {
    return [];
  }

  const footprints = nodes.map(toFootprint);
  const maxPairComparisons = positiveIntegerOption("maxPairComparisons", options.maxPairComparisons ?? DEFAULT_MAX_PAIR_COMPARISONS);
  const countComparison = () => {
    if (++budget.comparisons > maxPairComparisons) {
      throw new Error(`Board is too dense to cluster safely: exceeded ${maxPairComparisons} pair comparisons. Reduce overlapping elements or split the board into sections.`);
    }
  };
  const gapThreshold =
    options.gapThreshold ??
    (options.adaptiveGapThreshold === false
      ? DEFAULT_GAP_THRESHOLD
      : adaptiveGapThreshold(footprints, countComparison));
  if (!Number.isFinite(gapThreshold) || gapThreshold < 0) {
    throw new Error("geometricPreCluster: gapThreshold must be a finite number >= 0");
  }
  const maxClusterSize = positiveIntegerOption(
    "maxClusterSize",
    options.maxClusterSize ?? DEFAULT_MAX_CLUSTER_SIZE,
  );
  const maxGridCellsPerNode = positiveIntegerOption(
    "maxGridCellsPerNode",
    options.maxGridCellsPerNode ?? DEFAULT_MAX_GRID_CELLS_PER_NODE,
  );
  const maxGridEntries = positiveIntegerOption("maxGridEntries", options.maxGridEntries ?? DEFAULT_MAX_GRID_ENTRIES);

  // Union-find over node indices; union any pair within the gap threshold.
  const parent = footprints.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    // Path compression.
    let current = i;
    while (parent[current] !== root) {
      const next = parent[current]!;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };

  const { cells, overflowIndices } = buildGrid(
    footprints,
    gapThreshold,
    maxGridCellsPerNode,
    maxGridEntries,
    budget,
  );
  for (const cellMembers of cells.values()) {
    for (let a = 0; a < cellMembers.length; a++) {
      for (let b = a + 1; b < cellMembers.length; b++) {
        countComparison();
        const i = cellMembers[a]!;
        const j = cellMembers[b]!;
        if (find(i) === find(j)) {
          continue; // Already connected — skip the exact gap computation.
        }
        if (footprintGap(footprints[i]!, footprints[j]!) <= gapThreshold) {
          union(i, j);
        }
      }
    }
  }

  // Oversized footprints are compared by node count rather than canvas area.
  // Pairs where both sides overflow are visited only once.
  const overflowSet = new Set(overflowIndices);
  for (const i of overflowIndices) {
    for (let j = 0; j < footprints.length; j++) {
      countComparison();
      if (i === j || (overflowSet.has(j) && j < i) || find(i) === find(j)) {
        continue;
      }
      if (footprintGap(footprints[i]!, footprints[j]!) <= gapThreshold) {
        union(i, j);
      }
    }
  }

  // Collect members per root.
  const groups = new Map<number, NormalizedNode[]>();
  footprints.forEach((fp, i) => {
    const root = find(i);
    const members = groups.get(root) ?? [];
    members.push(fp.node);
    groups.set(root, members);
  });

  // Stable "reading order" (top-left first) for deterministic cluster IDs.
  const clusters = [...groups.values()].flatMap((members) =>
    splitOversizedGroup(members, maxClusterSize).map(toCluster),
  );
  clusters.sort((a, b) => a.boundingBox.y - b.boundingBox.y || a.boundingBox.x - b.boundingBox.x);
  clusters.forEach((cluster, index) => {
    cluster.id = `cluster_${index + 1}`;
  });

  return clusters;
}

/**
 * Estimates a board-specific gap threshold from the median nearest-neighbor
 * gap: nodes inside a group sit a small, fairly uniform gap apart, while
 * separate board areas are much further away, so a multiple of the median
 * within-group spacing separates the two regimes. Overlapping/touching
 * neighbors (gap 0) carry no spacing signal and are ignored. Falls back to
 * DEFAULT_GAP_THRESHOLD for small boards or when there is no usable signal.
 */
function adaptiveGapThreshold(footprints: Footprint[], countComparison: () => void): number {
  if (footprints.length < MIN_ADAPTIVE_NODES) {
    return DEFAULT_GAP_THRESHOLD;
  }

  const sampleLimit = Math.max(1, Math.min(ADAPTIVE_SAMPLE_LIMIT, Math.floor(MAX_ADAPTIVE_COMPARISONS / footprints.length)));
  const step = Math.max(1, Math.ceil(footprints.length / sampleLimit));
  const nearestGaps: number[] = [];
  for (let i = 0; i < footprints.length; i += step) {
    let nearest = Infinity;
    for (let j = 0; j < footprints.length; j++) {
      if (i === j) continue;
      countComparison();
      const gap = footprintGap(footprints[i]!, footprints[j]!);
      if (gap < nearest) nearest = gap;
    }
    if (Number.isFinite(nearest) && nearest > 0.5) {
      nearestGaps.push(nearest);
    }
  }

  // Mostly overlapping/touching nodes → no spacing signal to calibrate on.
  if (nearestGaps.length < footprints.length / step / 4) {
    return DEFAULT_GAP_THRESHOLD;
  }

  nearestGaps.sort((a, b) => a - b);
  const median = nearestGaps[Math.floor(nearestGaps.length / 2)]!;
  return Math.min(ADAPTIVE_MAX, Math.max(ADAPTIVE_MIN, ADAPTIVE_FACTOR * median));
}

/**
 * Spatial hash: maps "cellX:cellY" → indices of all footprints whose
 * threshold-inflated bounds touch that cell. Rotated footprints use the
 * union of their AABB and disc bounds, since the disc of a thin rotated
 * node can poke out of its AABB. Footprints above the per-node cell cap are
 * returned via overflowIndices for bounded pairwise comparison.
 */
interface GridIndex {
  cells: Map<string, number[]>;
  overflowIndices: number[];
}

function buildGrid(
  footprints: Footprint[],
  gapThreshold: number,
  maxGridCellsPerNode: number,
  maxGridEntries: number,
  budget: SpatialWorkBudget,
): GridIndex {
  const cellSize = Math.max(128, gapThreshold);
  const inflate = gapThreshold / 2;
  const cells = new Map<string, number[]>();
  const overflowIndices: number[] = [];

  footprints.forEach((fp, index) => {
    const { node } = fp;
    let minX = node.x;
    let minY = node.y;
    let maxX = node.x + node.width;
    let maxY = node.y + node.height;
    if (fp.rotated) {
      minX = Math.min(minX, fp.centerX - fp.radius);
      minY = Math.min(minY, fp.centerY - fp.radius);
      maxX = Math.max(maxX, fp.centerX + fp.radius);
      maxY = Math.max(maxY, fp.centerY + fp.radius);
    }

    const firstCellX = Math.floor((minX - inflate) / cellSize);
    const lastCellX = Math.floor((maxX + inflate) / cellSize);
    const firstCellY = Math.floor((minY - inflate) / cellSize);
    const lastCellY = Math.floor((maxY + inflate) / cellSize);
    const columns = lastCellX - firstCellX + 1;
    const rows = lastCellY - firstCellY + 1;
    const cellCount = columns * rows;
    if (
      !Number.isSafeInteger(firstCellX) ||
      !Number.isSafeInteger(lastCellX) ||
      !Number.isSafeInteger(firstCellY) ||
      !Number.isSafeInteger(lastCellY) ||
      !Number.isSafeInteger(cellCount) ||
      cellCount > maxGridCellsPerNode
    ) {
      overflowIndices.push(index);
      return;
    }

    budget.gridEntries += cellCount;
    if (budget.gridEntries > maxGridEntries) {
      throw new Error(`Board geometry exceeds the ${maxGridEntries}-entry spatial index limit. Reduce oversized shapes or split the board into sections.`);
    }

    for (let cx = firstCellX; cx <= lastCellX; cx++) {
      for (let cy = firstCellY; cy <= lastCellY; cy++) {
        const key = `${cx}:${cy}`;
        const members = cells.get(key) ?? [];
        members.push(index);
        cells.set(key, members);
      }
    }
  });

  return { cells, overflowIndices };
}

/** Builds the distance-check footprint for a node (see module JSDoc). */
function toFootprint(node: NormalizedNode): Footprint {
  const geometry = [node.x, node.y, node.width, node.height, node.rotation];
  if (geometry.some((value) => !Number.isFinite(value)) || node.width < 0 || node.height < 0) {
    throw new Error(
      `geometricPreCluster: node ${node.id} has invalid non-finite or negative geometry`,
    );
  }

  const footprint = {
    node,
    centerX: node.x + node.width / 2,
    centerY: node.y + node.height / 2,
    radius: (node.width + node.height) / 4,
    rotated: Math.abs(node.rotation) > 1e-6,
  };
  if (![footprint.centerX, footprint.centerY, footprint.radius].every(Number.isFinite)) {
    throw new Error(`geometricPreCluster: node ${node.id} geometry exceeds numeric limits`);
  }
  return footprint;
}

/** Euclidean gap between two footprints (0 when they touch/overlap). */
function footprintGap(a: Footprint, b: Footprint): number {
  if (a.rotated || b.rotated) {
    // Disc-based distance as soon as one side is rotated: center distance
    // minus both effective radii (disc for rotated, disc approximation for
    // the partner too — mixing disc and rect gap would bias the result).
    const centerDistance = Math.hypot(a.centerX - b.centerX, a.centerY - b.centerY);
    return Math.max(0, centerDistance - a.radius - b.radius);
  }

  // Exact axis-aligned rect-to-rect gap for the common unrotated case.
  const dx = Math.max(
    0,
    Math.max(a.node.x, b.node.x) - Math.min(a.node.x + a.node.width, b.node.x + b.node.width),
  );
  const dy = Math.max(
    0,
    Math.max(a.node.y, b.node.y) - Math.min(a.node.y + a.node.height, b.node.y + b.node.height),
  );
  return Math.hypot(dx, dy);
}

/** Wraps a member list into a Cluster with the union bounding box. */
function toCluster(members: NormalizedNode[]): Cluster {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of members) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }

  return {
    id: "cluster_0", // reassigned after sorting in geometricPreCluster
    nodeIds: members.map((n) => n.id),
    boundingBox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  };
}

/** Recursively bisects a connected component along its longest spatial axis. */
function splitOversizedGroup(
  members: NormalizedNode[],
  maxClusterSize: number,
): NormalizedNode[][] {
  const pending: NormalizedNode[][] = [members];
  const result: NormalizedNode[][] = [];

  while (pending.length > 0) {
    const group = pending.pop()!;
    if (group.length <= maxClusterSize) {
      result.push(group);
      continue;
    }

    const bounds = toCluster(group).boundingBox;
    const splitOnX = bounds.width >= bounds.height;
    const sorted = [...group].sort((a, b) => {
      const primaryA = splitOnX ? a.x + a.width / 2 : a.y + a.height / 2;
      const primaryB = splitOnX ? b.x + b.width / 2 : b.y + b.height / 2;
      const secondaryA = splitOnX ? a.y + a.height / 2 : a.x + a.width / 2;
      const secondaryB = splitOnX ? b.y + b.height / 2 : b.x + b.width / 2;
      return primaryA - primaryB || secondaryA - secondaryB || a.id.localeCompare(b.id);
    });
    const midpoint = Math.ceil(sorted.length / 2);
    pending.push(sorted.slice(midpoint), sorted.slice(0, midpoint));
  }

  return result;
}

function positiveIntegerOption(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`geometricPreCluster: ${name} must be a positive safe integer`);
  }
  return value;
}
