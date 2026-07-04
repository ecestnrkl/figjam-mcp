import { describe, it, expect } from "vitest";
import { geometricPreCluster } from "../src/lib/spatialCluster.js";
import type { NormalizedNode } from "../src/types.js";

/** Builds a minimal NormalizedNode for synthetic point-cloud tests. */
function makeNode(
  id: string,
  x: number,
  y: number,
  width = 200,
  height = 100,
  rotation = 0,
): NormalizedNode {
  return { id, name: id, type: "STICKY", x, y, width, height, rotation };
}

/** Finds the cluster containing a given node id (or fails the test). */
function clusterOf(clusters: ReturnType<typeof geometricPreCluster>, nodeId: string) {
  const cluster = clusters.find((c) => c.nodeIds.includes(nodeId));
  expect(cluster).toBeDefined();
  return cluster!;
}

describe("geometricPreCluster", () => {
  it("returns [] for empty input", () => {
    expect(geometricPreCluster([])).toEqual([]);
  });

  it("groups nearby nodes and separates distant groups", () => {
    const nodes = [
      // Group A — stickies 20 px apart.
      makeNode("a1", 0, 0),
      makeNode("a2", 220, 0),
      makeNode("a3", 0, 120),
      // Group B — far away on the canvas.
      makeNode("b1", 2000, 1500),
      makeNode("b2", 2220, 1500),
    ];

    const clusters = geometricPreCluster(nodes);
    expect(clusters).toHaveLength(2);

    expect([...clusterOf(clusters, "a1").nodeIds].sort()).toEqual(["a1", "a2", "a3"]);
    expect([...clusterOf(clusters, "b1").nodeIds].sort()).toEqual(["b1", "b2"]);
  });

  it("assigns a rotated node to the correct nearby group", () => {
    const nodes = [
      // Group A.
      makeNode("a1", 0, 0),
      makeNode("a2", 220, 0),
      // Rotated sticky next to a2: Figma reports the inflated axis-aligned
      // bounding box (120×120 sticky at 45°  → ~140×140 AABB). Its disc
      // footprint (center (530, 70), radius 70) sits ~66 px from a2.
      makeNode("r1", 460, 0, 140, 140, 45),
      // Group B — outside the rotated node's reach.
      makeNode("b1", 2000, 1500),
    ];

    const clusters = geometricPreCluster(nodes);
    expect(clusters).toHaveLength(2);

    const groupA = clusterOf(clusters, "a1");
    expect(groupA.nodeIds).toContain("r1");
    expect(clusterOf(clusters, "b1").nodeIds).not.toContain("r1");
  });

  it("respects a configurable gap threshold", () => {
    // Edge-to-edge gap between the two nodes: 300 px.
    const nodes = [makeNode("n1", 0, 0), makeNode("n2", 500, 0)];

    expect(geometricPreCluster(nodes, { gapThreshold: 100 })).toHaveLength(2);
    expect(geometricPreCluster(nodes, { gapThreshold: 400 })).toHaveLength(1);
  });

  it("computes the union bounding box and reading-order cluster ids", () => {
    const nodes = [
      // Lower-right group first in the input — ids must still follow
      // top-left reading order.
      makeNode("late", 1000, 900, 100, 50),
      makeNode("early1", 0, 0, 100, 50),
      makeNode("early2", 120, 40, 100, 50),
    ];

    const clusters = geometricPreCluster(nodes);
    expect(clusters).toHaveLength(2);

    const first = clusters[0]!;
    expect(first.id).toBe("cluster_1");
    expect(first.nodeIds).toContain("early1");
    expect(first.boundingBox).toEqual({ x: 0, y: 0, width: 220, height: 90 });

    expect(clusters[1]!.id).toBe("cluster_2");
  });
});
