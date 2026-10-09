import type { BoardData } from "../../src/types.js";
import { retrievalFixtures, textNode } from "./retrieval.js";

export interface SyntheticChangeFixture {
  name: string;
  kind: "text-edit" | "table-cell-edit" | "node-added" | "node-removed" | "internal-arrow-reversed";
  before: BoardData;
  after: BoardData;
  changedNodeId: string;
  changedCellId?: string;
  expected: {
    addedNodes: number; removedNodes: number; editedNodes: number;
    addedConnections: number; removedConnections: number; tableCellChanges: number;
  };
}

/** Every retrieval board has an explicit, synthetic revision with known changes. */
export const changeFixtures: SyntheticChangeFixture[] = retrievalFixtures.map((fixture, index) => {
  const before = structuredClone(fixture.board);
  const kind = before.nodes.some((node) => node.table) ? "table-cell-edit" :
    (["text-edit", "node-added", "node-removed", "internal-arrow-reversed"] as const)[index % 4]!;
  // Arrow cases deliberately put both ends inside one cluster: they must still
  // appear in the full graph diff even though inter-cluster edges stay empty.
  if (kind === "internal-arrow-reversed") {
    if (before.nodes.length === 1) before.nodes.push(textNode("eval:target", "The next workflow step."));
    before.clusters = [{ ...before.clusters[0]!, id: "eval:workflow", nodeIds: before.nodes.map((node) => node.id), confirmedNodeIds: before.nodes.map((node) => node.id) }];
    before.connectorEdges = [{ connectorId: "eval:arrow", fromNodeId: before.nodes[0]!.id, toNodeId: before.nodes[1]!.id, direction: "forward", label: "precedes" }];
    before.clusterRelations = [];
  }
  const after = structuredClone(before);
  after.createdAt = before.createdAt + 1;
  after.snapshotId = "b".repeat(64);
  let changedNodeId = fixture.expectedNodeId ?? before.nodes[0]!.id;
  let changedCellId: string | undefined;
  const expected = { addedNodes: 0, removedNodes: 0, editedNodes: 0, addedConnections: 0, removedConnections: 0, tableCellChanges: 0 };

  if (kind === "table-cell-edit") {
    const table = after.nodes.find((node) => node.table)!;
    const cell = table.table!.cells.find((item) => item.id === fixture.expectedNodeId) ?? table.table!.cells[0]!;
    cell.text += " (revised)";
    changedNodeId = table.id;
    changedCellId = cell.id;
    expected.editedNodes = 1;
    expected.tableCellChanges = 1;
  } else if (kind === "text-edit") {
    after.nodes.find((node) => node.id === changedNodeId)!.text += " (revised)";
    expected.editedNodes = 1;
  } else if (kind === "node-added") {
    changedNodeId = "eval:added";
    const node = textNode(changedNodeId, "A newly agreed release milestone.");
    after.nodes.push(node);
    after.clusters.push({ ...before.clusters[0]!, id: "eval:added-cluster", label: "New milestone", nodeIds: [node.id], confirmedNodeIds: [node.id] });
    expected.addedNodes = 1;
  } else if (kind === "node-removed") {
    after.nodes = after.nodes.filter((node) => node.id !== changedNodeId);
    after.clusters = after.clusters.map((cluster) => ({ ...cluster,
      nodeIds: cluster.nodeIds.filter((id) => id !== changedNodeId),
      confirmedNodeIds: cluster.confirmedNodeIds.filter((id) => id !== changedNodeId),
    })).filter((cluster) => cluster.nodeIds.length > 0);
    expected.removedNodes = 1;
  } else {
    changedNodeId = "eval:arrow";
    after.connectorEdges![0]!.direction = "reverse";
    expected.addedConnections = 1;
    expected.removedConnections = 1;
  }
  return { name: fixture.name, kind, before, after, changedNodeId, changedCellId, expected };
});
