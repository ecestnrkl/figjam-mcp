import type { BoardData, NormalizedNode, RefinedCluster } from "../../src/types.js";

/** Synthetic large change: each snapshot contains 4,700 nodes and no external data. */
export function largeDiffBoards(): [BoardData, BoardData] {
  const note = (id: string, text: string, type = "STICKY"): NormalizedNode => ({
    id, name: type === "TABLE" ? `Matrix ${id}` : type === "CONNECTOR" ? "Connector" : "Sticky",
    type, x: 0, y: 0, width: 100, height: 100, rotation: 0, text,
  });
  const group = (id: string, nodeIds: string[]): RefinedCluster => ({
    id, nodeIds, confirmedNodeIds: nodeIds, label: `Synthetic ${id}`,
    summary: "Synthetic workshop context. ".repeat(8), boundingBox: { x: 0, y: 0, width: 100, height: 100 },
  });
  const snapshot = (revised: boolean): BoardData => {
    const edited = Array.from({ length: 1060 }, (_, i) => note(`1:${i}`, `Synthetic note ${i}: ${revised ? "Tuesday" : "Monday"}`));
    const replaced = Array.from({ length: 1020 }, (_, i) => note(`${revised ? 3 : 2}:${i}`, `Synthetic replacement ${i}`));
    const tables = Array.from({ length: 26 }, (_, i) => ({
      ...note(`4:${i}`, "", "TABLE"), text: undefined,
      table: { cells: Array.from({ length: 30 }, (_, row) => ({
        id: `cell-${i}-${row}`, row, column: 0,
        text: `${"Synthetic context ".repeat(20)}${revised ? "Tuesday" : "Monday"} ${"Additional context ".repeat(20)}`,
      })) },
    }));
    const arrows = Array.from({ length: 455 }, (_, i) => note(`${revised ? 6 : 5}:${i}`, "", "CONNECTOR"));
    const stable = Array.from({ length: 2139 }, (_, i) => note(`7:${i}`, `Stable synthetic note ${i}`));
    const modified = Array.from({ length: 155 }, (_, i) => group(`modified-${i}`, [
      ...edited.filter((_, index) => index % 155 === i).map((item) => item.id),
      ...tables.filter((_, index) => index % 155 === i).map((item) => item.id),
    ]));
    const replacedClusters = Array.from({ length: 85 }, (_, i) =>
      group(`${revised ? "new" : "removed"}-${i}`, replaced.slice(i * 12, (i + 1) * 12).map((item) => item.id)));
    return {
      boardId: "SyntheticDiff4700", fileKey: "SyntheticDiff4700", docStructureHint: "freeform",
      nodes: [...edited, ...replaced, ...tables, ...arrows, ...stable], clusters: [...modified, ...replacedClusters],
      connectorEdges: arrows.map((item, i) => ({
        connectorId: item.id, fromNodeId: `1:${i}`, toNodeId: `1:${i + 1}`, label: revised ? "blocks" : "supports",
      })),
      clusterRelations: [], createdAt: revised ? 2000 : 1000,
    };
  };
  return [snapshot(false), snapshot(true)];
}
