import { describe, expect, it } from "vitest";
import { connectionsForEvidence, countConnectionsForEvidence, evidenceTokens, formatEvidence, formatEvidenceConnection, retrieveEvidence, snapshotIdForBoard, tableCellPositions } from "../src/lib/evidence.js";
import { evidenceBoard, textNode } from "./fixtures/retrieval.js";
import type { NormalizedNode, TableCell } from "../src/types.js";

/** Without a row, this cell keeps its table at cell excerpts. */
const LOOSE_CELL: TableCell = { id: "cell:loose", text: "Loose note" };

describe("source evidence", () => {
  it.each(["both", "either"] as const)("omits unlabeled self-loops from connections and counts with %s ends", (ends) => {
    const board = evidenceBoard("SelfLoops123", [textNode("1:1", "Note"), textNode("1:2", "Other note")]);
    board.connectorEdges = [
      { connectorId: "loop", fromNodeId: "1:1", toNodeId: "1:1" },
      { connectorId: "empty", fromNodeId: "1:1", toNodeId: "1:1", label: "" },
      { connectorId: "whitespace", fromNodeId: "1:1", toNodeId: "1:1", label: "  \n " },
      { connectorId: "labeled", fromNodeId: "1:1", toNodeId: "1:1", label: "retry", direction: "undirected" },
      { connectorId: "normal", fromNodeId: "1:1", toNodeId: "1:2" },
    ];
    const evidence = retrieveEvidence(board).evidence;
    const connections = connectionsForEvidence(board, evidence, ends);
    expect(connections.map((edge) => edge.connectorId)).toEqual(["labeled", "normal"]);
    expect(countConnectionsForEvidence(board, evidence, ends)).toBe(2);
    expect(formatEvidenceConnection(connections[0]!)).toBe("1:1 — 1:1 (retry)");
  });

  it("omits unlabeled section self-loops before the page limit and omitted count", () => {
    const board = evidenceBoard();
    board.nodes.push({ ...textNode("1:0", ""), name: "Notes", type: "SECTION", sectionIds: [] });
    board.connectorEdges = [
      ...Array.from({ length: 101 }, (_, i) => ({ connectorId: `loop:${i}`, fromNodeId: "1:0", toNodeId: "1:0", direction: "undirected" as const })),
      { connectorId: "labeled", fromNodeId: "1:0", toNodeId: "1:0", label: "retry", direction: "undirected" },
    ];
    const evidence = retrieveEvidence(board).evidence;
    const connections = connectionsForEvidence(board, evidence, "either");
    expect(connections.map((edge) => edge.connectorId)).toEqual(["labeled"]);
    expect(countConnectionsForEvidence(board, evidence, "either") - connections.length).toBe(0);
    expect(formatEvidenceConnection(connections[0]!)).toBe("1:0 «Notes» — 1:0 «Notes» (retry)");
  });

  it("does not lose raw text omitted by a cluster summary", () => {
    const board = evidenceBoard();
    const result = retrieveEvidence(board, { query: "idempotency" });
    expect(result.evidence[0]).toMatchObject({ nodeId: "1:1", sourceType: "board_text", modelDerived: false, pageId: "0:1", sectionIds: ["1:0"] });
    expect(result.evidence[0]?.text).toContain("idempotency key");
    expect(result.evidence[0]?.url).toBe("https://www.figma.com/board/Evidence123?node-id=1%3A1");
  });

  it("assigns stable IDs to sources and changes them between snapshots", () => {
    const board = evidenceBoard();
    const first = retrieveEvidence(board).evidence[0]!;
    expect(retrieveEvidence(structuredClone(board)).evidence[0]?.evidenceId).toBe(first.evidenceId);
    const next = { ...board, snapshotId: "b".repeat(64) };
    expect(retrieveEvidence(next).evidence[0]?.evidenceId).not.toBe(first.evidenceId);
    expect(snapshotIdForBoard(next)).toBe(next.snapshotId);
  });

  it("retains all chunks of long text and never cuts surrogate pairs", () => {
    const text = "🧠".repeat(1201);
    const result = retrieveEvidence(evidenceBoard("LongEmoji123", [textNode("1:9", text)]));
    expect(result.evidence.map((item) => item.text).join("")).toBe(text);
    expect(result.evidence.every((item) => item.text.length <= 1200)).toBe(true);
    expect(result.evidence.every((item) => !/[\uD800-\uDBFF]$/.test(item.text))).toBe(true);
  });

  it("returns table cells with coordinates and a renderable table link", () => {
    const node = { ...textNode("10:1", "combined text"), type: "TABLE", table: { cells: [{ id: "cell:2", text: "Owner: Ada", row: 2, column: 1 }, LOOSE_CELL] } };
    const board = evidenceBoard("TableCase123", [node]);
    const result = retrieveEvidence(board, { nodeIds: ["10:1"] });
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toMatchObject({ nodeId: "cell:2", row: 2, column: 1, renderNodeId: "10:1", sourceType: "table_cell" });
    expect(result.evidence[0]?.url).toContain("node-id=10%3A1");
    expect(retrieveEvidence(board, { nodeIds: ["cell:2"] }).evidence).toHaveLength(1);
  });

  it("retrieves separate table values with a matching label and prioritizes its row", () => {
    const board = evidenceBoard("TableLabel123", [{ ...textNode("10:1", ""), name: "Table 1", type: "TABLE", table: { cells: [
      { id: "cell:other", text: "Unrelated value", row: 0, column: 1 },
      { id: "cell:label", text: "Budget", row: 1, column: 0 },
      { id: "cell:value", text: "999", row: 1, column: 1 }, LOOSE_CELL,
    ] } }]);
    const result = retrieveEvidence(board, { query: "Wie hoch ist das Budget?", includeNeighbors: true, tableNeighborLimit: 1 });
    expect(result.evidence.map((item) => item.nodeId)).toEqual(["cell:label", "cell:value"]);
    expect(result.totalMatched).toBe(1);
    expect(formatEvidence(result.evidence[1]!)).toContain("Table node: 10:1; Row index: 1; Column index: 1");
    expect(formatEvidence(result.evidence[1]!)).toContain("\n999");
    expect(retrieveEvidence(board, { query: "quantum reactor", includeNeighbors: true }).evidence).toEqual([]);
    expect(retrieveEvidence(board, { nodeIds: ["cell:label"], includeNeighbors: true }).evidence.map((item) => item.nodeId)).toEqual(["cell:label"]);
  });

  it("bounds table expansion globally and shares it across matching rows", () => {
    const board = evidenceBoard("TableBound123", [{ ...textNode("10:1", ""), type: "TABLE", table: { cells: [
      ...Array.from({ length: 3 }, (_, row) => [
        { id: `label:${row}`, text: "Budget", row, column: 0 },
        ...Array.from({ length: 10 }, (_, column) => ({ id: `value:${row}:${column}`, text: String(row * 100 + column), row, column: column + 1 })),
      ]).flat(), LOOSE_CELL,
    ] } }]);
    const result = retrieveEvidence(board, { query: "Budget", includeNeighbors: true });
    expect(result.evidence).toHaveLength(3 + 6);
    expect(new Set(result.evidence.map((item) => item.evidenceId)).size).toBe(9);
    expect(result.evidence.slice(3).map((item) => item.row)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(result.evidence.slice(3).every((item) => item.renderNodeId === "10:1")).toBe(true);
  });

  it("adds bounded table context without inventing missing cell coordinates", () => {
    const board = evidenceBoard("TableNoPosition123", [{ ...textNode("10:1", ""), type: "TABLE", table: { cells: [
      { id: "cell:label", text: "Budget" }, { id: "cell:value", text: "999" },
    ] } }]);
    const result = retrieveEvidence(board, { query: "Budget", includeNeighbors: true });
    expect(result.evidence.map((item) => item.text)).toEqual(["Budget", "999"]);
    expect(result.evidence.every((item) => item.row === undefined && item.column === undefined)).toBe(true);
    expect(formatEvidence(result.evidence[1]!)).toContain("Table node: 10:1");
    expect(formatEvidence(result.evidence[1]!)).not.toMatch(/Row index|Column index/);
  });

  it("keeps the primary boundary separate from same-row context and excludes other rows", () => {
    const board = evidenceBoard("TableExactRow", [{ ...textNode("table", ""), type: "TABLE", table: { cells: [
      { id: "unrelated-person", text: "Person A", row: 0, column: 0 },
      { id: "target", text: "Budget", row: 4, column: 0 },
      { id: "value", text: "999", row: 4, column: 1 },
      { id: "other-date", text: "Friday", row: 5, column: 1 }, LOOSE_CELL,
    ] } }]);
    const result = retrieveEvidence(board, { query: "Budget", limit: 1, includeNeighbors: true });
    expect(result.evidence.map((item) => item.nodeId)).toEqual(["target", "value"]);
    expect(result.primaryEvidenceIds).toEqual([result.evidence[0]!.evidenceId]);
  });

  it("does not attach arbitrary leading rows from a large table without coordinates", () => {
    const board = evidenceBoard("LargeUnpositioned", [{ ...textNode("table", ""), type: "TABLE", table: { cells: [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `person:${i}`, text: `Person ${i}` })),
      { id: "target", text: "Synthesis: slide 10, one minute" },
    ] } }]);
    const result = retrieveEvidence(board, { query: "synthesis", includeNeighbors: true });
    expect(result.evidence.map((item) => item.nodeId)).toEqual(["target"]);
    expect(result.evidence[0]!.row).toBeUndefined();
  });

  it("adds an unpositioned small table completely or not at all", () => {
    const board = evidenceBoard("AtomicTable", [{ ...textNode("table", ""), type: "TABLE", table: { cells: [
      { id: "label", text: "Budget" }, { id: "value", text: "999" }, { id: "unit", text: "EUR" },
    ] } }]);
    expect(retrieveEvidence(board, { query: "Budget", includeNeighbors: true, tableNeighborLimit: 1 })
      .evidence.map((item) => item.nodeId)).toEqual(["label"]);
    expect(retrieveEvidence(board, { query: "Budget", includeNeighbors: true, tableNeighborLimit: 2 })
      .evidence.map((item) => item.nodeId)).toEqual(["label", "value", "unit"]);
  });

  it("does not use added table cells as new graph expansion anchors", () => {
    const board = evidenceBoard("TableGraphBoundary", [
      { ...textNode("table", ""), type: "TABLE", table: { cells: [
        { id: "label", text: "Budget", row: 0, column: 0 },
        { id: "value", text: "999", row: 0, column: 1 }, LOOSE_CELL,
      ] } },
      textNode("direct", "Approval process"), textNode("indirect", "Unrelated department"),
    ]);
    board.connectorEdges = [
      { connectorId: "edge:direct", fromNodeId: "label", toNodeId: "direct", direction: "reverse" },
      { connectorId: "edge:indirect", fromNodeId: "value", toNodeId: "indirect" },
    ];
    const result = retrieveEvidence(board, { query: "Budget", limit: 1, includeNeighbors: true });
    expect(result.evidence.map((item) => item.nodeId)).toEqual(["label", "value", "direct"]);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]!.direction).toBe("reverse");
  });

  it("does not choose a prefix of a large graph-neighbor table", () => {
    const board = evidenceBoard("GraphTableBound", [
      textNode("source", "Payment finding"),
      { ...textNode("table", ""), type: "TABLE", table: { cells:
        Array.from({ length: 10 }, (_, i) => ({ id: `value:${i}`, text: `Cell ${i}` })),
      } },
      textNode("other", "Release plan"),
    ]);
    board.connectorEdges = [
      { connectorId: "edge:table", fromNodeId: "source", toNodeId: "table" },
      { connectorId: "edge:other", fromNodeId: "source", toNodeId: "other" },
    ];
    const result = retrieveEvidence(board, { query: "payment", limit: 1, includeNeighbors: true, neighborLimit: 3 });
    expect(result.evidence.map((item) => item.nodeId)).toEqual(["source", "other"]);
  });

  it("marks visual interpretations explicitly without replacing original text", () => {
    const board = evidenceBoard();
    board.nodes[0]!.imageRef = "image-hash";
    board.clusters[0]!.summarySource = "vision_llm";
    board.clusters[0]!.summary = "The mockup appears to show a blue checkout button.";
    const result = retrieveEvidence(board);
    expect(result.evidence.map((item) => item.sourceType)).toEqual(["board_text", "model_interpretation"]);
    expect(result.evidence[1]?.modelDerived).toBe(true);
  });

  it("expands only one connector hop and preserves arrow direction", () => {
    const board = evidenceBoard("Graph123", [textNode("1:1", "Payment finding"), textNode("1:2", "Release plan"), textNode("1:3", "Marketing strategy")]);
    board.connectorEdges = [
      { connectorId: "2:1", fromNodeId: "1:1", toNodeId: "1:2", direction: "reverse", label: "depends on" },
      { connectorId: "2:2", fromNodeId: "1:2", toNodeId: "1:3", direction: "bidirectional" },
    ];
    const result = retrieveEvidence(board, { query: "payment", limit: 1, includeNeighbors: true });
    expect(result.evidence.map((item) => item.nodeId)).toEqual(["1:1", "1:2"]);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]?.direction).toBe("reverse");
  });

  it("does not let one long graph neighbor starve every other neighbor", () => {
    const board = evidenceBoard("NeighborFair123", [
      textNode("1:1", "Payment finding"),
      textNode("1:2", "Lengthy release description. ".repeat(250)),
      textNode("1:3", "A separate launch dependency."),
    ]);
    board.connectorEdges = [
      { connectorId: "2:1", fromNodeId: "1:1", toNodeId: "1:2" },
      { connectorId: "2:2", fromNodeId: "1:1", toNodeId: "1:3" },
    ];
    const result = retrieveEvidence(board, { query: "payment", limit: 1, includeNeighbors: true, neighborLimit: 2 });
    expect(result.evidence.map((item) => item.nodeId)).toEqual(["1:1", "1:2", "1:3"]);
  });

  it("uses Unicode word boundaries rather than substring matching", () => {
    expect(evidenceTokens("Kündigungsfrist ＰＡＹＭＥＮＴ")).toEqual(["kündigungsfrist", "payment"]);
    const board = evidenceBoard("Word123", [textNode("1:1", "A pineapple delivery")]);
    expect(retrieveEvidence(board, { query: "apple" }).evidence).toEqual([]);
  });

  it("finds original text through node, page and section names", () => {
    const board = evidenceBoard("Metadata123", [{ ...textNode("1:1", "Ada"), name: "Escalation owner" }]);
    board.nodes.push(
      { ...textNode("0:1", ""), type: "CANVAS", name: "Operations", pageId: "0:1", sectionIds: [] },
      { ...textNode("1:0", ""), type: "SECTION", name: "Reliability" },
    );
    for (const query of ["Escalation", "Operations", "Reliability"]) {
      const source = retrieveEvidence(board, { query }).evidence.find((item) => item.nodeId === "1:1");
      expect(source).toMatchObject({ text: "Ada", sourceType: "board_text", modelDerived: false,
        nodeName: "Escalation owner", pageName: "Operations", sectionNames: ["Reliability"] });
      expect(formatEvidence(source!)).toContain("Node name: Escalation owner; Page: Operations; Sections: Reliability");
      expect(formatEvidence(source!)).toContain("\nAda");
    }
  });

  it("bounds source names and preserves the innermost section in deeply nested metadata", () => {
    const node = { ...textNode("1:1", "Ada"), name: "Owner".repeat(100),
      sectionIds: Array.from({ length: 20 }, (_, i) => `section:${i}`) };
    const board = evidenceBoard("BoundedMetadata123", [node]);
    board.nodes.push(...node.sectionIds.map((id) => ({ ...textNode(id, ""), name: id.repeat(100), type: "SECTION" })));
    const source = retrieveEvidence(board, { nodeIds: ["1:1"] }).evidence[0]!;
    expect(source.nodeName!.length).toBeLessThanOrEqual(160);
    expect(source.sectionNames).toHaveLength(16);
    expect(source.sectionIds!.at(-1)).toBe("section:19");
    expect(source.sectionNames!.at(-1)).toContain("section:19");
    expect(source.sectionNames!.every((name) => name.length <= 80)).toBe(true);
  });

  it("returns names of textless nodes as original metadata, never as board text", () => {
    const board = evidenceBoard("NamedShape123", [{ ...textNode("1:1", ""), type: "RECTANGLE", name: "Escalation owner" }]);
    const result = retrieveEvidence(board, { query: "Escalation" });
    expect(result.evidence.find((item) => item.nodeId === "1:1" && !item.modelDerived)).toMatchObject({
      nodeId: "1:1", text: "Escalation owner", sourceType: "board_metadata", modelDerived: false,
    });
  });
});

describe("table rows", () => {
  const table = (cells: TableCell[], id = "5:1"): NormalizedNode => ({ ...textNode(id, ""), name: "Table 1", type: "TABLE", table: { cells } });
  /** Cell IDs in the REST API form T<table ID>;<row ID>;<column ID>, row by row. */
  const grid = (rows: string[][], id = "5:1"): TableCell[] =>
    rows.flatMap((cells, row) => cells.map((text, column) => ({ id: `T${id};6:${row};7:${column}`, text })));
  const positions = (cells: TableCell[]) => tableCellPositions(table(cells)).map(({ row, column }) => [row, column]);

  it("derives row and column from cell IDs that form a complete rectangle, in order of first appearance", () => {
    expect(positions(grid([["a", "b"], ["c", "d"]]))).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
    expect(positions([
      { id: "T5:1;9:9;8:2", text: "a" }, { id: "T5:1;9:9;8:1", text: "b" },
      { id: "T5:1;9:1;8:2", text: "c" }, { id: "T5:1;9:1;8:1", text: "d" },
    ])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
  });

  it("derives nothing from foreign IDs, missing cells or an incomplete rectangle; recorded values come first", () => {
    const none = [undefined, undefined];
    expect(positions([...grid([["a"]]), { id: "cell:b", text: "b" }])).toEqual([none, none]);
    expect(positions(grid([["a", "b"]], "9:9"))).toEqual([none, none]);
    expect(positions([{ id: "T5:1;6:0;7:0;8:0", text: "a" }])).toEqual([none]);
    expect(positions(grid([["a", "b"], ["c", "d"]]).slice(0, 3))).toEqual([none, none, none]);
    expect(positions([{ id: "T5:1;6:0;7:0", text: "a" }, { id: "T5:1;6:0;7:0", text: "b" }])).toEqual([none, none]);
    const recorded = grid([["a", "b"], ["c", "d"]]);
    recorded[3] = { ...recorded[3]!, row: 7, column: 4 };
    expect(positions(recorded)).toEqual([[0, 0], [0, 1], [1, 0], [7, 4]]);
    expect(positions([{ id: "a", text: "a", row: 2 }, { id: "b", text: "b" }])).toEqual([[2, undefined], none]);
  });

  it("returns one excerpt per row with cells in column order, empty cells kept and distinct IDs for equal rows", () => {
    const board = evidenceBoard("TableRows123", [table(grid([["Name", "Age", "City"], ["Ada", "", "London"], ["Ada", "", "London"]]))]);
    const rows = retrieveEvidence(board).evidence;
    expect(rows.map((item) => [item.row, item.text])).toEqual([[0, "Name | Age | City"], [1, "Ada |  | London"], [2, "Ada |  | London"]]);
    for (const item of rows) {
      expect(item).toMatchObject({ nodeId: "5:1", renderNodeId: "5:1", sourceType: "table_row", modelDerived: false, chunkIndex: 0, truncated: false });
      expect(item.column).toBeUndefined();
      expect(item.url).toContain("node-id=5%3A1");
    }
    expect(new Set(rows.map((item) => item.evidenceId)).size).toBe(3);
    const recorded = table([
      { id: "b", text: "B", row: 0, column: 1 }, { id: "a", text: "A", row: 0, column: 0 },
      { id: "d", text: "D", row: 0, column: 3 }, { id: "c", text: "", row: 0, column: 2 },
    ]);
    expect(retrieveEvidence(evidenceBoard("TableOrder123", [recorded])).evidence.map((item) => item.text)).toEqual(["A | B |  | D"]);
    expect(formatEvidence(rows[1]!)).toContain('original table row; cells separated by "|"');
    expect(formatEvidence(rows[1]!)).toContain("Row index: 1");
  });

  it("splits a long row into parts like long text", () => {
    const long = Array.from({ length: 8 }, (_, column) => `Column ${column} note `.repeat(12).trim());
    const wide = evidenceBoard("TableWideRow123", [table(grid([long.map((_, column) => `Heading ${column}`), long]))]);
    const parts = retrieveEvidence(wide, { nodeIds: ["T5:1;6:1;7:3"] }).evidence;
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((item) => item.row === 1 && item.truncated && item.text.length <= 1200)).toBe(true);
    expect(parts.map((item) => item.chunkIndex)).toEqual(parts.map((_, index) => index));
    expect(parts.map((item) => item.text).join(" ")).toBe(long.join(" | "));
  });

  it("keeps cell excerpts for a table without rows", () => {
    const board = evidenceBoard("TableCells123", [table([{ id: "cell:a", text: "Alpha" }, { id: "cell:b", text: "Beta" }])]);
    expect(retrieveEvidence(board).evidence.map((item) => [item.nodeId, item.sourceType, item.row])).toEqual([
      ["cell:a", "table_cell", undefined], ["cell:b", "table_cell", undefined],
    ]);
  });

  it("returns the row of a cell ID and every row of the table ID in order", () => {
    const board = evidenceBoard("TableLookup123", [table(grid([["Metric", "Value"], ["Alpha", "1"], ["Beta", "2"]]))]);
    expect(retrieveEvidence(board, { nodeIds: ["T5:1;6:2;7:1"] }).evidence.map((item) => [item.row, item.text])).toEqual([[2, "Beta | 2"]]);
    expect(retrieveEvidence(board, { nodeIds: ["5:1"] }).evidence.map((item) => item.row)).toEqual([0, 1, 2]);
  });

  it("keeps the rows of a table together in the unfocused order while other clusters still take turns", () => {
    const rows = table(grid([["Metric", "Value"], ["Alpha", "1"], ["Beta", "2"]]));
    const board = evidenceBoard("TableInterleave123", [textNode("1:1", "Note A1"), rows, textNode("1:3", "Note A2"),
      textNode("2:1", "Note B1"), textNode("2:2", "Note B2"), textNode("2:3", "Note B3")]);
    const cluster = (id: string, nodeIds: string[]) => ({ ...board.clusters[0]!, id, nodeIds, confirmedNodeIds: nodeIds });
    board.clusters = [cluster("a", ["1:1", "5:1", "1:3"]), cluster("b", ["2:1", "2:2", "2:3"])];
    expect(retrieveEvidence(board).evidence.map((item) => item.sourceType === "table_row" ? `row ${item.row}` : item.text)).toEqual([
      "Note A1", "Note B1", "row 0", "row 1", "row 2", "Note B2", "Note A2", "Note B3",
    ]);
  });

  it("adds the first row of the table to a match in a later row, once and within the neighbor limit", () => {
    const board = evidenceBoard("TableHeader123", [table(grid([["Metric", "Value"], ["Alpha", "1"], ["Beta", "2"], ["Budget", "999"], ["Gamma", "3"]]))]);
    const later = retrieveEvidence(board, { query: "Budget", includeNeighbors: true });
    expect(later.evidence.map((item) => item.row)).toEqual([0, 3]);
    expect(later.primaryEvidenceIds).toEqual([later.evidence[1]!.evidenceId]);
    expect(later.totalMatched).toBe(1);
    expect(retrieveEvidence(board, { query: "Metric", includeNeighbors: true }).evidence.map((item) => item.row)).toEqual([0]);
    const both = retrieveEvidence(board, { query: "Value Budget", includeNeighbors: true }).evidence;
    expect(both.map((item) => item.row).sort((a, b) => a! - b!)).toEqual([0, 3]);
    expect(retrieveEvidence(board, { query: "Budget", includeNeighbors: true, tableNeighborLimit: 0 }).evidence.map((item) => item.row)).toEqual([3]);
    expect(retrieveEvidence(board, { query: "Budget" }).evidence.map((item) => item.row)).toEqual([3]);
  });
});
