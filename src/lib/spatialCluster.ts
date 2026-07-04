import type { NormalizedNode, Cluster } from "../types.js";

/**
 * Maximum gap (in canvas px) between two nodes' footprints for them to be
 * considered part of the same cluster. FigJam stickies default to ~240 px,
 * so 160 px links neighboring stickies while keeping separate board areas
 * apart. Override via GeometricClusterOptions.gapThreshold.
 */
const DEFAULT_GAP_THRESHOLD = 160;

export interface GeometricClusterOptions {
  /** Max euclidean gap between node footprints to join a cluster (canvas px). */
  gapThreshold?: number;
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

/**
 * Groups NormalizedNode entries into spatial clusters purely by geometry
 * (single-linkage: a node joins a cluster if it is within `gapThreshold` of
 * ANY node already in it), before any vision-based refinement is applied in
 * visionInterpreter.ts.
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
 * Returns coarse cluster candidates (IDs + bounding boxes only); labels and
 * summaries are added later by the vision step.
 */
export function geometricPreCluster(
  nodes: NormalizedNode[],
  options: GeometricClusterOptions = {},
): Cluster[] {
  const gapThreshold = options.gapThreshold ?? DEFAULT_GAP_THRESHOLD;

  if (nodes.length === 0) {
    return [];
  }

  const footprints = nodes.map(toFootprint);

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

  for (let i = 0; i < footprints.length; i++) {
    for (let j = i + 1; j < footprints.length; j++) {
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
  const clusters = [...groups.values()].map(toCluster);
  clusters.sort((a, b) => a.boundingBox.y - b.boundingBox.y || a.boundingBox.x - b.boundingBox.x);
  clusters.forEach((cluster, index) => {
    cluster.id = `cluster_${index + 1}`;
  });

  return clusters;
}

/** Builds the distance-check footprint for a node (see module JSDoc). */
function toFootprint(node: NormalizedNode): Footprint {
  return {
    node,
    centerX: node.x + node.width / 2,
    centerY: node.y + node.height / 2,
    radius: (node.width + node.height) / 4,
    rotated: Math.abs(node.rotation) > 1e-6,
  };
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
  const minX = Math.min(...members.map((n) => n.x));
  const minY = Math.min(...members.map((n) => n.y));
  const maxX = Math.max(...members.map((n) => n.x + n.width));
  const maxY = Math.max(...members.map((n) => n.y + n.height));

  return {
    id: "cluster_0", // reassigned after sorting in geometricPreCluster
    nodeIds: members.map((n) => n.id),
    boundingBox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  };
}
