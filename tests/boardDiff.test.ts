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
  it("counts a changed table once and identifies changed, added and removed cells", () => {
    const baseline = board([node("table", undefined, {
      type: "TABLE", table: { cells: [
        { id: "budget", text: "100", row: 0, column: 1 },
        { id: "old", text: "Old value" },
      ] },
    })], [cluster("table-cluster", "Budget", ["table"])], 1);
    const current = board([node("table", undefined, {
      type: "TABLE", table: { cells: [
        { id: "budget", text: "999", row: 0, column: 1 },
        { id: "new", text: "New value" },
      ] },
    })], [cluster("table-cluster", "Budget", ["table"])], 2);
    const diff = diffBoards(baseline, current);
    expect(diff.stats).toMatchObject({ editedNodes: 1, addedNodes: 0, removedNodes: 0, modifiedClusters: 1 });
    expect(diff.tableCellChanges).toEqual([
      expect.objectContaining({ tableNodeId: "table", cellId: "budget", changeType: "modified", previousText: "100", currentText: "999", previousRow: 0, currentColumn: 1 }),
      expect.objectContaining({ cellId: "old", changeType: "removed", previousText: "Old value" }),
      expect.objectContaining({ cellId: "new", changeType: "added", currentText: "New value" }),
    ]);
  });

  it("reports a changed cell of a table read as rows per cell", () => {
    const grid = (value: string) => node("5:1", undefined, { type: "TABLE", table: { cells: [["Item", "Amount"], ["Budget", value]]
      .flatMap((cells, row) => cells.map((text, column) => ({ id: `T5:1;6:${row};7:${column}`, text }))) } });
    const diff = diffBoards(board([grid("100")], [cluster("table-cluster", "Budget", ["5:1"])], 1),
      board([grid("999")], [cluster("table-cluster", "Budget", ["5:1"])], 2));
    expect(diff.stats).toMatchObject({ editedNodes: 1, modifiedClusters: 1 });
    expect(diff.tableCellChanges).toEqual([expect.objectContaining({
      tableNodeId: "5:1", cellId: "T5:1;6:1;7:1", changeType: "modified", previousText: "100", currentText: "999",
    })]);
  });

  it("detects visual edits and changes to connector direction", () => {
    const nodes = [node("a", undefined, { contentFingerprint: "red" }), node("b", "Target")];
    const clusters = [cluster("one", "Process", ["a", "b"])];
    const baseline = board(nodes, clusters, 1);
    baseline.connectorEdges = [{ connectorId: "edge", fromNodeId: "a", toNodeId: "b", direction: "forward" }];
    const current = board([{ ...nodes[0]!, contentFingerprint: "green" }, nodes[1]!], clusters, 2);
    current.connectorEdges = [{ ...baseline.connectorEdges[0]!, direction: "reverse" }];
    const diff = diffBoards(baseline, current);
    expect(diff.stats).toMatchObject({ editedNodes: 1, modifiedClusters: 1, addedConnections: 1, removedConnections: 1 });
    expect(diff.addedConnections[0]).toBe('"a" ← "Target"');
  });

  it("does not treat a reversed endpoint encoding as a changed directed meaning", () => {
    const nodes = [node("a", "A"), node("b", "B")];
    const baseline = board(nodes, [], 1);
    baseline.connectorEdges = [{ connectorId: "edge", fromNodeId: "a", toNodeId: "b", direction: "forward" }];
    const current = board(nodes, [], 2);
    current.connectorEdges = [{ connectorId: "new-edge", fromNodeId: "b", toNodeId: "a", direction: "reverse" }];
    expect(diffBoards(baseline, current).stats).toMatchObject({ addedConnections: 0, removedConnections: 0 });
  });

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

  it("counts identical parallel connector arrows as a multiset", () => {
    const nodes = [node("a", "Idea"), node("b", "Action")];
    const clusters = [
      cluster("cluster_1", "Ideas", ["a"]),
      cluster("cluster_2", "Actions", ["b"]),
    ];
    const connector = (connectorId: string) => ({
      connectorId,
      fromNodeId: "a",
      toNodeId: "b",
      label: "supports",
    });
    const baseline = {
      ...board(nodes, clusters, 1),
      connectorEdges: [connector("old-1"), connector("old-2")],
    };
    const oneRemoved = {
      ...board(nodes, clusters, 2),
      connectorEdges: [connector("new-1")],
    };
    const oneAdded = {
      ...board(nodes, clusters, 3),
      connectorEdges: [connector("new-1"), connector("new-2"), connector("new-3")],
    };

    const removedDiff = diffBoards(baseline, oneRemoved);
    expect(removedDiff.stats.removedConnections).toBe(1);
    expect(removedDiff.removedConnections).toEqual([
      '"Ideas" → "Actions" — "supports"',
    ]);

    const addedDiff = diffBoards(baseline, oneAdded);
    expect(addedDiff.stats.addedConnections).toBe(1);
    expect(addedDiff.addedConnections).toEqual([
      '"Ideas" → "Actions" — "supports"',
    ]);
  });

  it("ignores connector id replacement when the semantic multiset is unchanged", () => {
    const nodes = [node("a", "Idea"), node("b", "Action")];
    const clusters = [
      cluster("cluster_1", "Ideas", ["a"]),
      cluster("cluster_2", "Actions", ["b"]),
    ];
    const baseline = {
      ...board(nodes, clusters, 1),
      connectorEdges: [
        { connectorId: "old", fromNodeId: "a", toNodeId: "b", label: "supports" },
      ],
    };
    const current = {
      ...board(nodes, clusters, 2),
      connectorEdges: [
        { connectorId: "new", fromNodeId: "a", toNodeId: "b", label: "supports" },
      ],
    };

    const diff = diffBoards(baseline, current);
    expect(diff.stats.addedConnections).toBe(0);
    expect(diff.stats.removedConnections).toBe(0);
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

  it("reports no changed cluster when only the cluster labels differ", () => {
    const nodes = [node("idea-1", "First idea"), node("idea-2", "Second idea"), node("decision", "Decision")];
    const edges = [{ connectorId: "arrow", fromNodeId: "idea-1", toNodeId: "decision", label: "chosen", direction: "forward" as const }];
    const baseline = { ...board(nodes, [cluster("ideas", "Second idea", ["idea-1", "idea-2"]),
      cluster("decisions", "Decision", ["decision"])], 1), connectorEdges: edges };
    const current = { ...board(nodes, [cluster("ideas", "Ideas", ["idea-1", "idea-2"]),
      cluster("decisions", "Decisions", ["decision"])], 2), connectorEdges: edges };
    const diff = diffBoards(baseline, current);
    expect(diff.stats).toMatchObject({ newClusters: 0, removedClusters: 0, modifiedClusters: 0, unchangedClusters: 2,
      addedConnections: 0, removedConnections: 0 });
  });

  describe("nodeChanges", () => {
    const section = node("5:80", undefined, { type: "SECTION", name: "4 · Decisions & next steps" });
    const sticky = (text: string, overrides: Partial<NormalizedNode> = {}) =>
      node("5:87", text, { name: "Sticky", sectionIds: ["5:80"], contentFingerprint: text, ...overrides });
    const pair = (before: NormalizedNode[], after: NormalizedNode[]) => diffBoards(
      board([section, ...before], [cluster("decisions", "Decisions", before.map((item) => item.id))], 1),
      board([section, ...after], [cluster("decisions", "Decisions", after.map((item) => item.id))], 2));

    it("names an edited sticky with its section, both texts and a link", () => {
      const diff = pair([sticky("Decision: The pilot starts on Monday, 2 Nov, in the main café.")],
        [sticky("Decision: The pilot starts on Monday, 9 Nov, in the main café.")]);
      expect(diff.nodeChanges).toEqual([{
        nodeId: "5:87", changeType: "edited", nodeType: "STICKY", sectionId: "5:80", section: "4 · Decisions & next steps",
        previousText: "Decision: The pilot starts on Monday, 2 Nov, in the main café.",
        currentText: "Decision: The pilot starts on Monday, 9 Nov, in the main café.",
        url: "https://www.figma.com/board/board?node-id=5%3A87", changes: ["text"],
      }]);
      expect(diff.nodeChangesOmitted).toBeUndefined();
      expect(diff.summaryText).toContain("Edited nodes (1):\n" +
        '- sticky 5:87 in "4 · Decisions & next steps": "Decision: The pilot starts on Monday, 2 Nov, in the main café." → ' +
        '"Decision: The pilot starts on Monday, 9 Nov, in the main café."\nNodes: +0 added / -0 removed / 1 edited.');
    });

    it("shows only the changed words of a long text, with context", () => {
      const filler = (word: string) => Array.from({ length: 50 }, (_, index) => `${word}${index}`).join(" ");
      const text = (changed: string) => `${filler("alpha")} ${changed} ${filler("omega")}`;
      const diff = pair([sticky(text("Monday"))], [sticky(text("Tuesday"))]);
      const [change] = diff.nodeChanges;
      expect(text("Monday").length).toBeGreaterThan(600);
      expect(change?.previousText).toMatch(/^….* Monday .*…$/);
      expect(change?.currentText).toMatch(/^….* Tuesday .*…$/);
      expect(change?.currentText).toContain("alpha49 Tuesday omega0");
      for (const excerpt of [change!.previousText!, change!.currentText!]) {
        expect(excerpt.length).toBeLessThanOrEqual(300);
        expect(excerpt).toMatch(/^…alpha\d+ .* omega\d+…$/); // cut at word boundaries
      }
      expect(diff.summaryText).toContain(`"${change!.previousText}" → "${change!.currentText}"`);

      const rewritten = pair([sticky("x ".repeat(400))], [sticky("y ".repeat(400))]).nodeChanges[0]!;
      expect(rewritten.previousText!.length).toBeLessThanOrEqual(300);
      expect(rewritten.currentText).toMatch(/^y y .*…$/);
    });

    it("names added and removed nodes with their first 160 characters", () => {
      const long = "Budget review ".repeat(20);
      const diff = pair([sticky("Old idea"), node("5:90", long, { name: "Sticky", sectionIds: ["5:80"] })],
        [sticky("Old idea"), node("5:91", "New idea", { type: "TEXT", name: "New idea" })]);
      expect(diff.nodeChanges).toEqual([
        expect.objectContaining({ nodeId: "5:91", changeType: "added", nodeType: "TEXT", currentText: "New idea" }),
        expect.objectContaining({ nodeId: "5:90", changeType: "removed", sectionId: "5:80", previousText: `${long.slice(0, 160)}…` }),
      ]);
      expect(diff.nodeChanges[0]).not.toHaveProperty("name");
      expect(diff.nodeChanges[0]).not.toHaveProperty("changes");
      expect(diff.summaryText).toContain('Added nodes (1):\n- text 5:91 outside sections: "New idea"');
      expect(diff.summaryText).toContain(`Removed nodes (1):\n- sticky 5:90 in "4 · Decisions & next steps": "${long.slice(0, 160)}…"`);
    });

    it("names a replaced image", () => {
      const image = (imageRef: string) => node("5:95", undefined, { type: "RECTANGLE", name: "Café floor plan", imageRef, sectionIds: ["5:80"] });
      const diff = pair([image("old-ref")], [image("new-ref")]);
      expect(diff.nodeChanges).toEqual([expect.objectContaining({ nodeId: "5:95", name: "Café floor plan", changes: ["image"] })]);
      expect(diff.summaryText).toContain('- image "Café floor plan" 5:95 in "4 · Decisions & next steps": image replaced');
    });

    it("calls a change of color or size an appearance change", () => {
      const color = pair([sticky("Same", { contentFingerprint: "yellow" })], [sticky("Same", { contentFingerprint: "green" })]);
      expect(color.nodeChanges).toEqual([expect.objectContaining({ previousText: "Same", currentText: "Same", changes: ["appearance"] })]);
      expect(color.summaryText).toContain('- sticky 5:87 in "4 · Decisions & next steps": appearance changed (color, size or style)');
      const size = pair([sticky("Same", { contentFingerprint: "100" })], [sticky("Same", { width: 200, contentFingerprint: "200" })]);
      expect(size.nodeChanges[0]?.changes).toEqual(["appearance"]);
    });

    it("says when texts differ only in whitespace", () => {
      const diff = pair([sticky("Pilot  starts\nMonday")], [sticky("Pilot starts Monday")]);
      expect(diff.nodeChanges).toEqual([expect.objectContaining({
        previousText: "Pilot starts Monday", currentText: "Pilot starts Monday", changes: ["text"],
      })]);
      expect(diff.summaryText).toContain('5:87 in "4 · Decisions & next steps": text changed only in whitespace: "Pilot starts Monday"');
    });

    it("shows the start of an unchanged long text", () => {
      const long = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
      const text = (fill: string) => node("5:88", long, { type: "TEXT", name: "Notes", contentFingerprint: fill });
      const change = pair([text("yellow")], [text("green")]).nodeChanges[0]!;
      expect(long.length).toBeGreaterThan(160);
      expect(change.changes).toEqual(["appearance"]);
      for (const excerpt of [change.previousText!, change.currentText!]) {
        expect(excerpt).toBe(`${long.slice(0, 160)}…`);
        expect(excerpt.length).toBeLessThanOrEqual(161);
      }
    });

    it("shows the start of a long text that changed only in whitespace", () => {
      const words = Array.from({ length: 40 }, (_, index) => `word${index}`);
      const diff = pair([sticky(words.join("  "))], [sticky(words.join(" "))]);
      const start = words.join(" ").slice(0, 160);
      expect(diff.nodeChanges[0]).toMatchObject({ previousText: `${start}…`, currentText: `${start}…`, changes: ["text"] });
      expect(diff.summaryText).toContain(`text changed only in whitespace: "${start}…"`);
    });

    it("lists at most 100 entries and 20 lines per block", () => {
      const notes = (suffix: string) => Array.from({ length: 150 }, (_, index) => node(`9:${index}`, `Note ${index}${suffix}`, { y: index }));
      const diff = pair(notes(""), notes(" (revised)"));
      expect(diff.nodeChanges).toHaveLength(100);
      expect(diff.nodeChangesOmitted).toBe(50);
      expect(diff.nodeChanges.slice(0, 2).map((change) => change.nodeId)).toEqual(["9:0", "9:1"]);
      const block = diff.summaryText.split("Edited nodes (150):\n")[1]!.split("\n");
      expect(block.slice(0, 20).every((line) => line.startsWith("- sticky 9:"))).toBe(true);
      expect(block[20]).toBe("- … and 130 more");
    });
  });

  describe("table cells", () => {
    const section = node("5:100", undefined, { type: "SECTION", name: "3 · Ideas" });
    const rows = [["Feature", "Owner", "Effort", "Status"], ["Pre-orders", "Ana", "M", "Done"], ["Sold-out badges", "Cem", "S", "In scope"]];
    const columnIds = ["5:5", "5:6", "5:7", "5:8"];
    // Cells as the REST API returns them: no stored row or column.
    const table = (grid: string[][], rowIds = grid.map((_, row) => `5:${row}`), name = "Feature priorities") => {
      const cells = grid.flatMap((cells, row) => cells.map((text, column) => ({ id: `T5:119;${rowIds[row]};${columnIds[column]}`, text })));
      return node("5:119", cells.map((cell) => cell.text).join("\n"), { type: "TABLE", name, sectionIds: ["5:100"], table: { cells } });
    };
    const edit = (row: number, column: number, text: string) =>
      rows.map((cells, r) => cells.map((value, c) => r === row && c === column ? text : value));
    const pair = (before: NormalizedNode[], after: NormalizedNode[]) => diffBoards(
      board([section, ...before], [cluster("ideas", "Ideas", before.map((item) => item.id))], 1),
      board([section, ...after], [cluster("ideas", "Ideas", after.map((item) => item.id))], 2));

    it("names a changed cell with table, row and column from its ID", () => {
      const diff = pair([table(rows)], [table(edit(2, 3, "In pilot"))]);
      expect(diff.tableCellChanges).toEqual([{
        tableNodeId: "5:119", cellId: "T5:119;5:2;5:8", changeType: "modified", previousText: "In scope", currentText: "In pilot",
        previousRow: 2, previousColumn: 3, currentRow: 2, currentColumn: 3,
        tableName: "Feature priorities", rowLabel: "Sold-out badges", columnLabel: "Status",
      }]);
      expect(diff.nodeChanges).toEqual([]);
      expect(diff.summaryText).toContain("Table cells (1):\n" +
        '- table "Feature priorities" 5:119 in "3 · Ideas", row 3 "Sold-out badges", column 4 "Status": "In scope" → "In pilot"\n' +
        "Nodes: +0 added / -0 removed / 1 edited.");
      expect(diff.summaryText).not.toContain("Edited nodes");
    });

    it("gives a header cell no label of its own", () => {
      const status = pair([table(rows)], [table(edit(0, 3, "State"))]).tableCellChanges[0]!;
      expect(status).toMatchObject({ currentRow: 0, currentColumn: 3, rowLabel: "Feature" });
      expect(status).not.toHaveProperty("columnLabel");
      const corner = pair([table(rows)], [table(edit(0, 0, "Item"))]).tableCellChanges[0]!;
      expect(corner).not.toHaveProperty("rowLabel");
      expect(corner).not.toHaveProperty("columnLabel");
      const unnamed = pair([table(rows, undefined, "Table 3")], [table(edit(0, 0, "Item"), undefined, "Table 3")]);
      expect(unnamed.tableCellChanges[0]).not.toHaveProperty("tableName");
      expect(unnamed.summaryText).toContain('- table 5:119 in "3 · Ideas", row 1, column 1: "Feature" → "Item"');
    });

    it("shows the start of a long cell that changed only in whitespace", () => {
      const words = Array.from({ length: 40 }, (_, index) => `word${index}`);
      const diff = pair([table(edit(2, 3, words.join("  ")))], [table(edit(2, 3, words.join(" ")))]);
      expect(diff.summaryText).toContain(
        `column 4 "Status": text changed only in whitespace: "${words.join(" ").slice(0, 160)}…"`);
    });

    it("keeps a cell readable when the IDs form no complete rectangle", () => {
      const ragged = (grid: string[][]) => {
        const result = table(grid);
        result.table!.cells.pop();
        return result;
      };
      const diff = pair([ragged(rows)], [ragged(edit(1, 3, "Blocked"))]);
      expect(diff.tableCellChanges).toEqual([expect.objectContaining({ cellId: "T5:119;5:1;5:8", currentText: "Blocked" })]);
      expect(diff.tableCellChanges[0]?.currentRow).toBeUndefined();
      expect(diff.tableCellChanges[0]).not.toHaveProperty("rowLabel");
      expect(diff.summaryText).toContain('- table "Feature priorities" 5:119 in "3 · Ideas", cell T5:119;5:1;5:8: "Done" → "Blocked"');
    });

    it("reports only the new cells of an inserted row", () => {
      const inserted = [rows[0]!, ["Group orders", "Dana", "L", "Idea"], ...rows.slice(1)];
      const diff = pair([table(rows)], [table(inserted, ["5:0", "5:9", "5:1", "5:2"])]);
      expect(diff.tableCellChanges.map((change) => [change.changeType, change.cellId, change.currentRow, change.currentColumn])).toEqual([
        ["added", "T5:119;5:9;5:5", 1, 0], ["added", "T5:119;5:9;5:6", 1, 1],
        ["added", "T5:119;5:9;5:7", 1, 2], ["added", "T5:119;5:9;5:8", 1, 3],
      ]);
      expect(diff.summaryText).toContain('- table "Feature priorities" 5:119 in "3 · Ideas", row 2 "Group orders", column 4 "Status": added "Idea"');
    });

    it("lists a new table once under added nodes", () => {
      const diff = pair([], [table(rows)]);
      expect(diff.tableCellChanges).toHaveLength(12);
      expect(diff.summaryText).toContain('Added nodes (1):\n- table "Feature priorities" 5:119 in "3 · Ideas": "Feature Owner Effort Status');
      expect(diff.summaryText).not.toContain("Table cells");
    });
  });
});
