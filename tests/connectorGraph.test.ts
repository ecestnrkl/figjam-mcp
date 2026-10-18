import { describe, expect, it } from "vitest";
import {
  buildClusterRelations,
  extractConnectorEdges,
  formatClusterRelations,
  formatNodeConnections,
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
      { connectorId: "c1", fromNodeId: "a", toNodeId: "b", label: "leads to", direction: "forward" },
    ]);
  });

  it("omits empty labels", () => {
    const edges = extractConnectorEdges([connector("c1", "a", "b", "   ")]);
    expect(edges[0]?.label).toBeUndefined();
  });

  it("excludes document and canvas anchors while preserving content self-connections", () => {
    const nodes = [node("canvas", { type: "CANVAS", parentId: "omitted-document" }),
      node("document", { type: "DOCUMENT" }), node("page", { type: "PAGE" }),
      node("a"), node("section", { type: "SECTION" }),
      ...["canvas", "document", "page", "omitted-document"].flatMap(id => [
        connector(`${id}-start`, id, "a"), connector(`${id}-end`, "a", id), connector(`${id}-self`, id, id),
      ]),
      connector("content-self", "a", "a", "repeat"), connector("section-link", "a", "section"),
    ];
    expect(extractConnectorEdges(nodes).map(edge => edge.connectorId)).toEqual(["content-self", "section-link"]);
    expect(formatNodeConnections(extractConnectorEdges(nodes), nodes)).toContain("a (a) → a (a) — repeat");
  });

  it.each([
    ["NONE", "LINE_ARROW", "forward", "→", [["one", "two"]]],
    ["LINE_ARROW", "NONE", "reverse", "←", [["two", "one"]]],
    ["LINE_ARROW", "LINE_ARROW", "bidirectional", "↔", [["one", "two"], ["two", "one"]]],
    ["NONE", "NONE", "undirected", "—", []],
    ["NONE", "TRIANGLE_FILLED", "forward", "→", [["one", "two"]]],
  ] as const)("keeps %s / %s caps consistent in node and cluster evidence", (start, end, direction, arrow, pairs) => {
    const nodes = [node("a"), node("b"), { ...connector("edge", "a", "b"),
      connectorStartArrowhead: start, connectorEndArrowhead: end }];
    const edges = extractConnectorEdges(nodes);
    expect(edges[0]?.direction).toBe(direction);
    expect(formatNodeConnections(edges, nodes)).toEqual([`a (a) ${arrow} b (b)`]);
    expect(buildClusterRelations(edges, [cluster("one", ["a"]), cluster("two", ["b"])])
      .map(relation => [relation.fromClusterId, relation.toClusterId])).toEqual(pairs);
  });

  it("preserves actual arrow direction and internal node evidence", () => {
    const nodes = [
      node("a", { text: "First" }), node("b", { text: "Second" }),
      { ...connector("reverse", "a", "b", "must precede"), connectorStartArrowhead: "ARROW_LINES", connectorEndArrowhead: "NONE" },
      { ...connector("both", "a", "b"), connectorStartArrowhead: "ARROW_LINES", connectorEndArrowhead: "ARROW_EQUILATERAL" },
      { ...connector("plain", "a", "b"), connectorStartArrowhead: "NONE", connectorEndArrowhead: "NONE" },
    ];
    const edges = extractConnectorEdges(nodes);
    expect(edges.map((edge) => edge.direction)).toEqual(["reverse", "bidirectional", "undirected"]);
    expect(buildClusterRelations(edges, [cluster("one", ["a", "b"])])).toEqual([]);
    expect(formatNodeConnections(edges, nodes, new Set(["a"]))).toEqual([
      "a (First) ← b (Second) — must precede", "a (First) ↔ b (Second)", "a (First) — b (Second)",
    ]);
    const intercluster = buildClusterRelations(edges, [cluster("one", ["a"]), cluster("two", ["b"])]);
    expect(intercluster).toEqual([
      { fromClusterId: "two", toClusterId: "one", labels: ["must precede"], edgeCount: 2 },
      { fromClusterId: "one", toClusterId: "two", labels: [], edgeCount: 1 },
    ]);
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
