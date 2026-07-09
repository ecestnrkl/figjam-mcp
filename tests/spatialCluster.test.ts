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

  it("matches a brute-force O(n²) reference on a random board", () => {
    // Deterministic PRNG so failures are reproducible.
    let seed = 42;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const nodes: NormalizedNode[] = Array.from({ length: 140 }, (_, i) =>
      makeNode(
        `n${i}`,
        Math.floor(random() * 4000),
        Math.floor(random() * 3000),
        60 + Math.floor(random() * 180),
        60 + Math.floor(random() * 120),
        random() < 0.2 ? 30 : 0,
      ),
    );

    const threshold = 160;
    const clusters = geometricPreCluster(nodes, { gapThreshold: threshold });

    // Reference: plain single-linkage over ALL pairs with the same metric
    // (exact rect gap; disc approximation as soon as one node is rotated).
    const gap = (a: NormalizedNode, b: NormalizedNode): number => {
      if (Math.abs(a.rotation) > 1e-6 || Math.abs(b.rotation) > 1e-6) {
        const distance = Math.hypot(
          a.x + a.width / 2 - (b.x + b.width / 2),
          a.y + a.height / 2 - (b.y + b.height / 2),
        );
        return Math.max(0, distance - (a.width + a.height) / 4 - (b.width + b.height) / 4);
      }
      const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
      const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
      return Math.hypot(dx, dy);
    };
    const parent = nodes.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (gap(nodes[i]!, nodes[j]!) <= threshold) parent[find(i)] = find(j);
      }
    }
    const referenceGroups = new Map<number, string[]>();
    nodes.forEach((node, i) => {
      const root = find(i);
      referenceGroups.set(root, [...(referenceGroups.get(root) ?? []), node.id]);
    });

    const canonical = (groups: string[][]) =>
      groups.map((ids) => [...ids].sort().join(",")).sort();
    expect(canonical(clusters.map((c) => c.nodeIds))).toEqual(
      canonical([...referenceGroups.values()]),
    );
  });

  it("adapts the threshold to dense boards", () => {
    // Three 3×2 sticky groups (120×80, 20 px intra gaps) separated by
    // 130 px — closer than the fixed 160 px default would keep apart.
    const nodes: NormalizedNode[] = [];
    for (let group = 0; group < 3; group++) {
      for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 2; row++) {
          nodes.push(
            makeNode(`g${group}_${col}_${row}`, group * 530 + col * 140, row * 100, 120, 80),
          );
        }
      }
    }

    // Fixed default threshold (adaptive off) merges everything…
    expect(geometricPreCluster(nodes, { adaptiveGapThreshold: false })).toHaveLength(1);
    // …the adaptive threshold (~3× the 20 px median neighbor gap) keeps
    // the three groups apart.
    expect(geometricPreCluster(nodes)).toHaveLength(3);
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
