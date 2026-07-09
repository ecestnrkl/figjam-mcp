import { describe, expect, it } from "vitest";
import {
  buildClusterRelations,
  extractConnectorEdges,
  formatClusterRelations,
} from "../src/lib/connectorGraph.js";
import type { Cluster, NormalizedNode, RefinedCluster } from "../src/types.js";

function node(id: string, overrides: Partial<NormalizedNode> = {}): NormalizedNode {
  return {
    id,
    name: id,
    type: "STICKY",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    ...overrides,
  };
}

function connector(
  id: string,
  from: string | undefined,
  to: string | undefined,
  label?: string,
): NormalizedNode {
  return node(id, {
    type: "CONNECTOR",
    connectorStartId: from,
    connectorEndId: to,
    text: label,
  });
}

function cluster(id: string, nodeIds: string[]): Cluster {
  return { id, nodeIds, boundingBox: { x: 0, y: 0, width: 100, height: 100 } };
}

describe("extractConnectorEdges", () => {
  it("keeps fully attached connectors and drops dangling ones", () => {
    const nodes = [
      node("a"),
      node("b"),
      connector("c1", "a", "b", "leads to"),
      connector("c2", "a", undefined),
      connector("c3", undefined, "b"),
    ];

    expect(extractConnectorEdges(nodes)).toEqual([
      { connectorId: "c1", fromNodeId: "a", toNodeId: "b", label: "leads to" },
    ]);
  });

  it("omits empty labels", () => {
    const edges = extractConnectorEdges([connector("c1", "a", "b", "   ")]);
    expect(edges[0]?.label).toBeUndefined();
  });
});

describe("buildClusterRelations", () => {
  const clusters = [cluster("cluster_1", ["a", "b"]), cluster("cluster_2", ["c"])];

  it("aggregates parallel edges and skips intra-cluster edges", () => {
    const relations = buildClusterRelations(
      [
        { connectorId: "c1", fromNodeId: "a", toNodeId: "c", label: "informs" },
        { connectorId: "c2", fromNodeId: "b", toNodeId: "c", label: "informs" },
        { connectorId: "c3", fromNodeId: "b", toNodeId: "c" },
        { connectorId: "c4", fromNodeId: "a", toNodeId: "b", label: "internal" },
      ],
      clusters,
    );

    expect(relations).toEqual([
      {
        fromClusterId: "cluster_1",
        toClusterId: "cluster_2",
        labels: ["informs"],
        edgeCount: 3,
      },
    ]);
  });

  it("ignores edges whose endpoints are not in any cluster", () => {
    const relations = buildClusterRelations(
      [{ connectorId: "c1", fromNodeId: "a", toNodeId: "ghost" }],
      clusters,
    );
    expect(relations).toEqual([]);
  });
});

describe("formatClusterRelations", () => {
  it("renders labeled arrow lines and drops relations to missing clusters", () => {
    const refined: RefinedCluster[] = [
      { ...cluster("cluster_1", ["a"]), label: "Research", summary: "", confirmedNodeIds: ["a"] },
      { ...cluster("cluster_2", ["c"]), label: "Ideas", summary: "", confirmedNodeIds: ["c"] },
    ];

    const lines = formatClusterRelations(
      [
        { fromClusterId: "cluster_1", toClusterId: "cluster_2", labels: ["informs"], edgeCount: 2 },
        { fromClusterId: "cluster_1", toClusterId: "cluster_9", labels: [], edgeCount: 1 },
      ],
      refined,
    );

    expect(lines).toEqual(['- "Research" → "Ideas" — "informs" (2 connectors)']);
  });
});
