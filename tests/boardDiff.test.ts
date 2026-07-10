import { describe, expect, it } from "vitest";
import { diffBoards } from "../src/lib/boardDiff.js";
import type { BoardData, NormalizedNode, RefinedCluster } from "../src/types.js";

function node(id: string, text?: string, overrides: Partial<NormalizedNode> = {}): NormalizedNode {
  return {
    id,
    name: id,
    type: "STICKY",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    text,
    ...overrides,
  };
}

function cluster(id: string, label: string, nodeIds: string[], summary = `${label} summary.`): RefinedCluster {
  return {
    id,
    label,
    summary,
    nodeIds,
    confirmedNodeIds: nodeIds,
    boundingBox: { x: 0, y: 0, width: 100, height: 100 },
  };
}

function board(nodes: NormalizedNode[], clusters: RefinedCluster[], createdAt: number): BoardData {
  return {
    boardId: "board",
    fileKey: "board",
    docStructureHint: "freeform",
    nodes,
    clusters,
    connectorEdges: [],
    clusterRelations: [],
    createdAt,
  };
}

describe("diffBoards", () => {
  it("reports no changes for identical snapshots", () => {
    const nodes = [node("a", "Hello"), node("b", "World")];
    const clusters = [cluster("cluster_1", "Greetings", ["a", "b"])];

    const diff = diffBoards(board(nodes, clusters, 1), board(nodes, clusters, 2));

    expect(diff.stats).toMatchObject({
      addedNodes: 0,
      removedNodes: 0,
      editedNodes: 0,
      newClusters: 0,
      removedClusters: 0,
      modifiedClusters: 0,
      unchangedClusters: 1,
    });
    expect(diff.summaryText).toContain("No changes");
  });

  it("classifies new, removed, modified, and unchanged clusters", () => {
    const baseline = board(
      [
        node("a1", "Interview quotes"),
        node("a2", "Survey results"),
        node("b1", "Old plan"),
        node("c1", "Stable note"),
      ],
      [
        cluster("cluster_1", "Research", ["a1", "a2"]),
        cluster("cluster_2", "Old planning", ["b1"]),
        cluster("cluster_3", "Stable", ["c1"]),
      ],
      1000,
    );

    const current = board(
      [
        node("a1", "Interview quotes"),
        node("a2", "Survey results — updated"),
        node("a3", "New interview"),
        node("c1", "Stable note"),
        node("d1", "Feedback round 2"),
        node("d2", "More feedback"),
      ],
      [
        cluster("cluster_1", "Research (extended)", ["a1", "a2", "a3"]),
        cluster("cluster_2", "Stable", ["c1"]),
        cluster("cluster_3", "Feedback", ["d1", "d2"], "Feedback collected after workshop 2."),
      ],
      2000,
    );

    const diff = diffBoards(baseline, current);

    expect(diff.stats).toMatchObject({
      addedNodes: 3, // a3, d1, d2
      removedNodes: 1, // b1
      editedNodes: 1, // a2
      newClusters: 1,
      removedClusters: 1,
      modifiedClusters: 1,
      unchangedClusters: 1,
    });
    expect(diff.newClusters).toEqual([
      { label: "Feedback", summary: "Feedback collected after workshop 2." },
    ]);
    expect(diff.removedClusters[0]?.label).toBe("Old planning");
    expect(diff.modifiedClusters[0]).toMatchObject({
      label: "Research (extended)",
      previousLabel: "Research",
      addedNodeCount: 1,
      removedNodeCount: 0,
      editedNodeCount: 1,
    });
    expect(diff.summaryText).toContain('New clusters (1):');
    expect(diff.summaryText).toContain('"Feedback"');
    expect(diff.summaryText).toContain('was "Research"');
  });

  it("diffs connector arrows with cluster labels", () => {
    const nodes = [node("a", "Idea"), node("b", "Action")];
    const clusters = [
      cluster("cluster_1", "Ideas", ["a"]),
      cluster("cluster_2", "Actions", ["b"]),
    ];
    const baseline = board(nodes, clusters, 1);
    const current = {
      ...board(nodes, clusters, 2),
      connectorEdges: [
        { connectorId: "c1", fromNodeId: "a", toNodeId: "b", label: "leads to" },
      ],
    };

    const diff = diffBoards(baseline, current);

    expect(diff.stats.addedConnections).toBe(1);
    expect(diff.addedConnections).toEqual(['"Ideas" → "Actions" — "leads to"']);
    expect(diff.summaryText).toContain("Connections: +1 / -0");
  });

  it("treats position-only moves as unchanged", () => {
    const baseline = board(
      [node("a", "Sticky")],
      [cluster("cluster_1", "Group", ["a"])],
      1,
    );
    const current = board(
      [node("a", "Sticky", { x: 5000, y: 5000 })],
      [cluster("cluster_1", "Group", ["a"])],
      2,
    );

    const diff = diffBoards(baseline, current);
    expect(diff.stats.editedNodes).toBe(0);
    expect(diff.stats.unchangedClusters).toBe(1);
  });
});
