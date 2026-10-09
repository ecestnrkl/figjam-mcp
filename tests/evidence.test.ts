import { describe, expect, it } from "vitest";
import { evidenceTokens, formatEvidence, retrieveEvidence, snapshotIdForBoard } from "../src/lib/evidence.js";
import { evidenceBoard, textNode } from "./fixtures/retrieval.js";

describe("source evidence", () => {
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
    const node = { ...textNode("10:1", "combined text"), type: "TABLE", table: { cells: [{ id: "cell:2", text: "Owner: Ada", row: 2, column: 1 }] } };
    const board = evidenceBoard("TableCase123", [node]);
    const result = retrieveEvidence(board, { nodeIds: ["10:1"] });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ nodeId: "cell:2", row: 2, column: 1, renderNodeId: "10:1", sourceType: "table_cell" });
    expect(result.evidence[0]?.url).toContain("node-id=10%3A1");
    expect(retrieveEvidence(board, { nodeIds: ["cell:2"] }).evidence).toHaveLength(1);
  });

  it("retrieves separate table values with a matching label and prioritizes its row", () => {
    const board = evidenceBoard("TableLabel123", [{ ...textNode("10:1", ""), name: "Table 1", type: "TABLE", table: { cells: [
      { id: "cell:other", text: "Unrelated value", row: 0, column: 1 },
      { id: "cell:label", text: "Budget", row: 1, column: 0 },
      { id: "cell:value", text: "999", row: 1, column: 1 },
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
    const board = evidenceBoard("TableBound123", [{ ...textNode("10:1", ""), type: "TABLE", table: { cells:
      Array.from({ length: 3 }, (_, row) => [
        { id: `label:${row}`, text: "Budget", row, column: 0 },
        ...Array.from({ length: 10 }, (_, column) => ({ id: `value:${row}:${column}`, text: String(row * 100 + column), row, column: column + 1 })),
      ]).flat(),
    } }]);
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
    expect(result.evidence[0]).toMatchObject({
      nodeId: "1:1", text: "Escalation owner", sourceType: "board_metadata", modelDerived: false,
    });
  });
});
