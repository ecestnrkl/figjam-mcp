import { describe, expect, it } from "vitest";
import { setBoard } from "../src/lib/cache.js";
import { getBoardContext } from "../src/tools/getBoardContext.js";
import type { BoardData } from "../src/types.js";

function board(boardId: string): BoardData {
  return {
    boardId,
    fileKey: boardId,
    docStructureHint: "freeform",
    createdAt: Date.now(),
    nodes: [],
    clusters: [
      {
        id: "cluster_1",
        label: "User research",
        summary: "Interview quotes about planning problems.",
        nodeIds: ["1:1"],
        confirmedNodeIds: ["1:1"],
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      },
      {
        id: "cluster_2",
        label: "Prototype ideas",
        summary: "Sketches for a calendar assistant.",
        nodeIds: ["1:2"],
        confirmedNodeIds: ["1:2"],
        boundingBox: { x: 500, y: 0, width: 100, height: 100 },
      },
    ],
    clusterRelations: [
      {
        fromClusterId: "cluster_1",
        toClusterId: "cluster_2",
        labels: ["inspires"],
        edgeCount: 1,
      },
    ],
  };
}

describe("getBoardContext", () => {
  it("renders cluster paragraphs plus the connector relations block", async () => {
    setBoard("ctx-relations", board("ctx-relations"));

    const output = await getBoardContext({ boardId: "ctx-relations" });

    expect(output.contextText).toContain("## User research");
    expect(output.contextText).toContain("## Connections between clusters");
    expect(output.contextText).toContain('"User research" → "Prototype ideas" — "inspires"');
    expect(output.relations).toEqual([
      { from: "User research", to: "Prototype ideas", label: "inspires", edgeCount: 1 },
    ]);
  });

  it("drops relations whose clusters were filtered out by the topic", async () => {
    setBoard("ctx-topic", board("ctx-topic"));

    const output = await getBoardContext({ boardId: "ctx-topic", topic: "interview quotes" });

    expect(output.clusters).toHaveLength(1);
    expect(output.contextText).not.toContain("Connections between clusters");
    expect(output.relations).toBeUndefined();
  });

  it("omits the relations block for boards without connectors", async () => {
    const data = board("ctx-none");
    data.clusterRelations = [];
    setBoard("ctx-none", data);

    const output = await getBoardContext({ boardId: "ctx-none" });

    expect(output.contextText).not.toContain("Connections between clusters");
    expect(output.relations).toBeUndefined();
  });
});
