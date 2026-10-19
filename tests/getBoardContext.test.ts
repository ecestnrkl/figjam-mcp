import { beforeEach, describe, expect, it } from "vitest";
import { setBoard } from "../src/lib/cache.js";
import { getBoardContext } from "../src/tools/getBoardContext.js";
import { getBoardContextInputSchema, getBoardContextOutputSchema } from "../src/schemas/getBoardContext.js";
import { evidenceBoard, textNode } from "./fixtures/retrieval.js";
import { largeBoard } from "./fixtures/largeBoard.js";
import { retrieveEvidence } from "../src/lib/evidence.js";
import { isGenericNodeName } from "../src/lib/nodeTree.js";

function board(boardId: string) {
  const data = evidenceBoard(boardId, [
    { ...textNode("1:1", "Interview quotes about planning problems."), name: "Interview notes" },
    { ...textNode("1:2", "Sketches for a calendar assistant."), name: "Calendar sketch" },
  ]);
  data.clusters[0]!.label = "User research";
  data.clusters[1]!.label = "Prototype ideas";
  data.clusterRelations = [{ fromClusterId: "cluster_0", toClusterId: "cluster_1", labels: ["inspires"], edgeCount: 1 }];
  data.connectorEdges = [{ connectorId: "2:1", fromNodeId: "1:1", toNodeId: "1:2", direction: "forward", label: "inspires" }];
  return data;
}

describe("getBoardContext", () => {
  it("retains cluster context and adds direct source evidence and connections", async () => {
    setBoard("Context123", board("Context123"));
    const output = await getBoardContext({ boardId: "Context123" });
    expect(output.contextText).toContain("Node name: Interview notes");
    expect(output.contextText).toContain("Node name: Calendar sketch");
    expect(output.contextText).toContain("## Cluster: User research");
    expect(output.contextText).toContain("## Connections between clusters");
    expect(output.contextText).toContain('"User research" → "Prototype ideas" — "inspires"');
    expect(output.evidence).toHaveLength(2);
    for (const item of output.evidence) {
      expect(output.contextText).toContain(`[${item.evidenceId}] original · node ${item.nodeId} · ${item.url}`);
    }
    expect(output.connections[0]?.connectorId).toBe("2:1");
    expect(output.relations).toEqual([{ from: "User research", to: "Prototype ideas", label: "inspires", edgeCount: 1 }]);
    expect(output.snapshotId).toBe("a".repeat(64));
  });

  it("includes bounded direct graph neighbors in focused context without expanding a second hop", async () => {
    const data = board("Topic123");
    data.nodes.push(textNode("1:3", "Brand campaign"));
    data.connectorEdges!.push({ connectorId: "2:2", fromNodeId: "1:2", toNodeId: "1:3", direction: "forward" });
    setBoard("Topic123", data);
    const output = await getBoardContext({ boardId: "Topic123", topic: "interview quotes" });
    expect(output.clusters).toHaveLength(2);
    expect(output.evidence[0]?.text).toContain("Interview quotes");
    expect(output.evidence.map((item) => item.nodeId)).toEqual(["1:1", "1:2"]);
    expect(output.contextText).toContain("1:1 → 1:2 (inspires)");
    expect(output.contextText).not.toContain("Brand campaign");
    expect(output.connections.map((item) => item.connectorId)).toEqual(["2:1"]);
    expect(output.totalMatched).toBe(2);
  });

  it("marks a model summary even when only the conflicting original source matches the topic", async () => {
    const data = evidenceBoard("SummaryOrigin123", [textNode("1:1", "The launch is Tuesday.")]);
    data.clusters[0]!.summarySource = "vision_llm";
    data.clusters[0]!.summary = "The launch is Friday.";
    setBoard(data.boardId, data);
    const output = await getBoardContext({ boardId: data.boardId, topic: "Tuesday" });
    expect(output.evidence).toHaveLength(1);
    expect(output.evidence[0]).toMatchObject({ text: "The launch is Tuesday.", modelDerived: false });
    expect(output.clusters[0]).toMatchObject({
      summary: "The launch is Friday.", summarySource: "vision_llm", modelDerived: true,
    });
    expect(getBoardContextOutputSchema.parse(output).clusters[0]?.modelDerived).toBe(true);
  });

  it("distinguishes deterministic summaries and conservatively marks unknown cached origins", async () => {
    const data = board("SummaryKinds123");
    data.clusters[0]!.summarySource = "deterministic";
    data.clusters[1]!.summarySource = "cache";
    setBoard(data.boardId, data);
    const output = await getBoardContext({ boardId: data.boardId });
    expect(output.clusters[0]).toMatchObject({ summarySource: "deterministic", modelDerived: false });
    expect(output.clusters[1]).toMatchObject({ summarySource: "cache", modelDerived: true });
  });

  it("paginates focused results and their graph neighbors without losing or repeating evidence", async () => {
    setBoard("NeighborPaging123", board("NeighborPaging123"));
    const first = await getBoardContext({ boardId: "NeighborPaging123", topic: "interview", limit: 1 });
    expect(first.evidence.map((item) => item.nodeId)).toEqual(["1:1"]);
    expect(first.totalMatched).toBe(2);
    const second = await getBoardContext({ boardId: "NeighborPaging123", topic: "interview", limit: 1, cursor: first.nextCursor });
    expect(second.evidence.map((item) => item.nodeId)).toEqual(["1:2"]);
    expect(second.nextCursor).toBeUndefined();
    expect(second.truncation.remainingEvidence).toBe(0);
  });

  it("paginates a table label and its separately stored value as distinct source excerpts", async () => {
    const data = evidenceBoard("TablePaging123", [{ ...textNode("10:1", "Budget\n999"), name: "Table 1", type: "TABLE", table: { cells: [
      { id: "label", text: "Budget", row: 0, column: 0 },
      { id: "value", text: "999", row: 0, column: 1 },
    ] } }]);
    setBoard(data.boardId, data);
    const first = await getBoardContext({ boardId: data.boardId, topic: "Budget", limit: 1 });
    expect(first.evidence.map(item => item.text)).toEqual(["Budget"]);
    expect(first.totalMatched).toBe(2);
    expect(first.nextCursor).toBeDefined();
    const second = await getBoardContext({ boardId: data.boardId, topic: "Budget", limit: 1, cursor: first.nextCursor });
    expect(second.evidence.map(item => item.text)).toEqual(["999"]);
    expect(second.contextText).toContain("Table node: 10:1; Row index: 0; Column index: 1");
    expect(second.nextCursor).toBeUndefined();
  });

  it("does not turn a missing topic into a full-board disclosure", async () => {
    setBoard("Missing123", board("Missing123"));
    const output = await getBoardContext({ boardId: "Missing123", topic: "quantum reactor" });
    expect(output).toMatchObject({ evidence: [], clusters: [], connections: [], totalMatched: 0, truncated: false });
    expect(output.contextText).toContain("No source evidence matched");
    expect(output.contextText).not.toContain("Interview quotes");
  });

  it("supports node lookup and rejects simultaneous topic and nodeIds", async () => {
    setBoard("Lookup123", board("Lookup123"));
    const output = await getBoardContext({ boardId: "Lookup123", nodeIds: ["1:2"] });
    expect(output.evidence.map((item) => item.nodeId)).toEqual(["1:2"]);
    await expect(getBoardContext({ boardId: "Lookup123", nodeIds: ["1:2"], topic: "calendar" })).rejects.toThrow(/either topic or nodeIds/);
  });

  it("shows the original source name that explains a metadata-only match", async () => {
    const data = evidenceBoard("NamedOwner123", [{ ...textNode("1:1", "Ada"), name: "Escalation owner" }]);
    setBoard(data.boardId, data);
    const output = await getBoardContext({ boardId: data.boardId, topic: "Escalation owner" });
    expect(output.evidence[0]).toMatchObject({ text: "Ada", nodeName: "Escalation owner", modelDerived: false });
    expect(output.contextText).toContain("Node name: Escalation owner");
    expect(output.contextText).toContain("\nAda");
  });

  it("covers different clusters before more excerpts from one large area", async () => {
    const data = evidenceBoard("Coverage123", Array.from({ length: 12 }, (_, i) => textNode(`1:${i}`, `Research note ${i}.`)));
    data.clusters = [
      { ...data.clusters[0]!, id: "large", label: "Large area", nodeIds: data.nodes.slice(0, 10).map((node) => node.id), confirmedNodeIds: data.nodes.slice(0, 10).map((node) => node.id) },
      { ...data.clusters[10]!, id: "small-a", label: "Small area A" },
      { ...data.clusters[11]!, id: "small-b", label: "Small area B" },
    ];
    setBoard(data.boardId, data);
    const output = await getBoardContext({ boardId: data.boardId, limit: 3 });
    expect(output.evidence.map((item) => item.nodeId)).toEqual(["1:0", "1:10", "1:11"]);
    expect(output.clusters).toHaveLength(3);
  });

  it("renders arrows within a cluster and reports connection omissions explicitly", async () => {
    const data = board("Arrows123");
    data.clusters = [{ ...data.clusters[0]!, nodeIds: ["1:1", "1:2"], confirmedNodeIds: ["1:1", "1:2"] }];
    data.clusterRelations = [];
    data.connectorEdges = Array.from({ length: 150 }, (_, i) => ({ connectorId: `2:${i}`, fromNodeId: "1:1", toNodeId: "1:2", direction: "reverse", label: `depends on ${i}` }));
    setBoard(data.boardId, data);
    const output = await getBoardContext({ boardId: data.boardId, maxChars: 4000 });
    expect(output.contextText).toContain("1:1 ← 1:2");
    expect(output.contextText).toContain("Interview quotes about planning problems.");
    expect(output.contextText).toContain("Sketches for a calendar assistant.");
    expect(output.connections.length).toBeGreaterThan(0);
    expect(output.truncation.omittedConnections).toBe(150 - output.connections.length);
    expect(output.truncation.omittedTextConnections).toBe(150 - output.connections.length);
    expect(output.truncated).toBe(true);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(4000);
    const roomy = await getBoardContext({ boardId: data.boardId, maxChars: 24000 });
    expect(roomy.connections).toHaveLength(100);
    expect(roomy.truncation.omittedConnections).toBe(50);
  });

  it("paginates without duplicate IDs or omitted excerpts and pins the snapshot", async () => {
    const data = evidenceBoard("Paging123", Array.from({ length: 12 }, (_, index) => textNode(`1:${index}`, `Unique note ${index}. ${"detail ".repeat(130)}`)));
    setBoard(data.boardId, data);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const output = await getBoardContext({ boardId: data.boardId, limit: 3, maxChars: 3000, cursor });
      expect(output.contextText.length).toBeLessThanOrEqual(3000);
      expect(output.totalMatched).toBe(12);
      expect(output.snapshotId).toBe(data.snapshotId);
      seen.push(...output.evidence.map((item) => item.evidenceId));
      cursor = output.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it("rejects cursor reuse with changed query, budget, snapshot or malformed encoding", async () => {
    setBoard("Cursor123", board("Cursor123"));
    const first = await getBoardContext({ boardId: "Cursor123", limit: 1 });
    expect(first.nextCursor).toBeDefined();
    for (const extra of [{ topic: "calendar" }, { maxChars: 14000 }, { snapshotId: "b".repeat(64) }, { limit: 2 }]) {
      await expect(getBoardContext({ boardId: "Cursor123", limit: 1, cursor: first.nextCursor, ...extra })).rejects.toThrow(/Cursor does not match/);
    }
    await expect(getBoardContext({ boardId: "Cursor123", cursor: "%%%" })).rejects.toThrow(/Invalid context cursor/);
  });

  it("rejects a cursor if refinement changes the results under the same source snapshot", async () => {
    const data = board("Refinement123");
    data.clusters[0]!.summarySource = "vision_llm";
    data.clusters[0]!.summary = "The visual interpretation contains a red button.";
    setBoard(data.boardId, data);
    const first = await getBoardContext({ boardId: data.boardId, limit: 1 });
    const refined = structuredClone(data);
    refined.clusters[0]!.summary = "The visual interpretation contains a green button.";
    setBoard(data.boardId, refined);
    await expect(getBoardContext({ boardId: data.boardId, limit: 1, cursor: first.nextCursor })).rejects.toThrow(/results changed/);
  });

  it("bounds the complete MCP response, including UTF-8 bytes and duplicated readable content", async () => {
    const data = evidenceBoard("Budget123", Array.from({ length: 200 }, (_, index) => textNode(`1:${index}`, "界".repeat(1000))));
    data.clusters.forEach((cluster) => { cluster.summary = "界".repeat(3000); });
    setBoard(data.boardId, data);
    const output = await getBoardContext({ boardId: data.boardId, limit: 100, maxChars: 24000 });
    const bytes = Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: output.contextText }], structuredContent: output }));
    expect(bytes).toBeLessThanOrEqual(128 * 1024);
    expect(output.contextText.length).toBeLessThanOrEqual(24000);
    expect(output.totalMatched).toBe(200);
    expect(output.truncated).toBe(true);
    expect(output.nextCursor).toBeDefined();
  });

  it("refuses too-small pages instead of silently dropping the rest of a source chunk", async () => {
    setBoard("Tiny123", evidenceBoard("Tiny123", [textNode("1:1", "evidence ".repeat(140))]));
    await expect(getBoardContext({ boardId: "Tiny123", maxChars: 512 })).rejects.toThrow(/cannot fit one source excerpt/);
  });

  it("validates hard page and node-count limits", () => {
    expect(getBoardContextInputSchema.parse({ boardId: "Schema123" })).toMatchObject({ limit: 20, maxChars: 12000 });
    for (const input of [{ limit: 101 }, { maxChars: 24001 }, { nodeIds: Array.from({ length: 51 }, (_, i) => `1:${i}`) }]) {
      expect(getBoardContextInputSchema.safeParse({ boardId: "Schema123", ...input }).success).toBe(false);
    }
  });
});

describe("getBoardContext response size", () => {
  beforeEach(() => setBoard("Large300", largeBoard("Large300")));

  it("keeps the whole structured response within maxChars on a large board", async () => {
    for (const input of [{}, { limit: 100, maxChars: 24000 }]) {
      const output = await getBoardContext({ boardId: "Large300", ...input });
      expect(JSON.stringify(output).length).toBeLessThanOrEqual(input.maxChars ?? 12000);
      expect(output.evidence.length).toBeGreaterThan(10);
      expect(output.nextCursor).toBeDefined();
      expect(getBoardContextOutputSchema.safeParse(output).success).toBe(true);
    }
  });

  it("pages through every excerpt exactly once and reports the page position", async () => {
    const data = largeBoard("Large40", 40, 10, 4);
    setBoard(data.boardId, data);
    const seen: string[] = [];
    let cursor: string | undefined;
    let total = 0;
    for (let page = 1; page <= 50; page++) {
      const output = await getBoardContext({ boardId: data.boardId, limit: 100, maxChars: 24000, cursor });
      expect(JSON.stringify(output).length).toBeLessThanOrEqual(24000);
      expect(output.contextText).toContain(`Page ${page} of `);
      total = output.totalMatched;
      seen.push(...output.evidence.map((item) => item.evidenceId));
      cursor = output.nextCursor;
      if (!cursor) {
        expect(output.contextText).toContain(`Page ${page} of ${page}; no excerpts remaining.`);
        break;
      }
      expect(output.contextText).toContain(`${output.truncation.remainingEvidence} excerpts remaining; pass nextCursor to continue.`);
    }
    expect(cursor).toBeUndefined();
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("points a partial long node to a nodeIds request, which returns all parts", async () => {
    const data = evidenceBoard("LongNode123", [textNode("9:1", "Long workshop protocol sentence. ".repeat(100))]);
    setBoard(data.boardId, data);
    const overview = await getBoardContext({ boardId: data.boardId, limit: 1 });
    expect(overview.evidence[0]).toMatchObject({ nodeId: "9:1", chunkIndex: 0, truncated: true });
    expect(overview.contextText).toContain('Part 1 of 3 — request get_board_context with nodeIds: ["9:1"] for all parts.');
    expect(overview.contextText).not.toContain("use the source link");
    const lookup = await getBoardContext({ boardId: data.boardId, nodeIds: ["9:1"] });
    expect(lookup.evidence.map((item) => item.chunkIndex)).toEqual([0, 1, 2]);
    expect(lookup.evidence.map((item) => item.text).join(" ")).toContain("Long workshop protocol sentence.");
    expect(lookup.contextText).toContain("[Part 3 of 3.]");
  });

  it("shortens a first excerpt that alone exceeds the budget instead of failing", async () => {
    const data = evidenceBoard("Shorten123", [textNode("9:2", "evidence ".repeat(140))]);
    setBoard(data.boardId, data);
    const output = await getBoardContext({ boardId: data.boardId, maxChars: 2500 });
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(2500);
    expect(output.evidence).toHaveLength(1);
    expect(output.evidence[0]!.text.length).toBeLessThan(1200);
    expect(output.truncated).toBe(true);
    expect(output.contextText).toContain('Shortened to fit maxChars. Part 1 of 2 — request get_board_context with nodeIds: ["9:2"] for all parts.');
  });

  it("shows the board overview only on the first page of an unfocused request", async () => {
    const first = await getBoardContext({ boardId: "Large300" });
    expect(first.contextText).toContain("## Board overview");
    expect(first.contextText).toContain("300 clusters, 3030 excerpts.");
    expect(first.contextText).toMatch(/Largest sections \(excerpts\), usable as topic: Theme 12 \(\d+\); Theme 11/);
    expect(first.contextText).toContain("Pass topic or nodeIds for smaller, more precise answers.");
    const second = await getBoardContext({ boardId: "Large300", cursor: first.nextCursor });
    const topic = await getBoardContext({ boardId: "Large300", topic: "onboarding mobile" });
    const nodes = await getBoardContext({ boardId: "Large300", nodeIds: ["10:0"] });
    for (const output of [second, topic, nodes]) expect(output.contextText).not.toContain("Board overview");
  });

  it("does not repeat node names that open the text and keeps model interpretations marked", async () => {
    const data = largeBoard("Names123", 3, 4, 1);
    data.clusters[1]!.summarySource = "vision_llm";
    data.clusters[1]!.summary = "The photo shows a whiteboard with a crossed-out checkout flow.";
    setBoard(data.boardId, data);
    const output = await getBoardContext({ boardId: data.boardId });
    const sticky = "Participant 0-1 said onboarding step 1 feels slow on mobile.";
    expect(output.contextText.split(sticky)).toHaveLength(2);
    expect(output.contextText).not.toContain("Node name: Participant");
    const original = output.evidence.find((item) => item.text === sticky)!;
    expect(original).not.toHaveProperty("nodeName");
    for (const field of ["pageId", "sectionIds", "clusterId", "clusterLabel", "renderNodeId"]) {
      expect(original).not.toHaveProperty(field);
    }
    expect(original).toMatchObject({ pageName: "Workshop", sectionNames: ["Theme 1"] });
    const interpretation = output.evidence.find((item) => item.sourceType === "model_interpretation")!;
    expect(interpretation).toMatchObject({ modelDerived: true });
    expect(output.contextText).toContain(`[${interpretation.evidenceId}] MODEL INTERPRETATION — verify against original`);
    expect(output.clusters.find((cluster) => cluster.summarySource === "vision_llm")?.summary)
      .toBe("The photo shows a whiteboard with a crossed-out checkout flow.");
    expect(output.clusters.find((cluster) => cluster.summarySource === "deterministic")?.summary)
      .toBe("Cluster contains 4 board elements with 4 extracted text items.");
    expect(output.contextText.match(/## Cluster: /g)).toHaveLength(3);
    expect(output.contextText).toContain("## Cluster: Participant 0-0 said onboarding step\nPage: Workshop; Sections: Theme 1");
    expect(getBoardContextOutputSchema.safeParse(output).success).toBe(true);
  });

  it("creates no excerpts for pages, sections and default names; named frames follow the content", async () => {
    const data = largeBoard("Metadata123", 20, 3, 2);
    setBoard(data.boardId, data);
    const all = retrieveEvidence(data).evidence;
    const types = new Map(data.nodes.map((node) => [node.id, node.type]));
    expect(all.some((item) => ["CANVAS", "SECTION", "VECTOR"].includes(types.get(item.nodeId)!))).toBe(false);
    expect(all.some((item) => /^Frame \d+$/.test(item.text))).toBe(false);
    const metadata = all.filter((item) => item.sourceType === "board_metadata");
    expect(metadata.map((item) => item.text)).toEqual(["Journey map 0", "Journey map 10"]);
    expect(all.slice(-2)).toEqual(metadata);
    expect(isGenericNodeName("Connector line 4")).toBe(true);
    expect(isGenericNodeName("Rounded rectangle")).toBe(true);
    expect(isGenericNodeName("Journey map 0")).toBe(false);
  });

  it("starts an unfocused first page with board text", async () => {
    const output = await getBoardContext({ boardId: "Large300" });
    expect(output.evidence[0]?.sourceType).toBe("board_text");
    expect(output.evidence.some((item) => item.sourceType === "board_metadata")).toBe(false);
  });

  it("ranks content matches before metadata matches for a topic", async () => {
    const data = evidenceBoard("TopicMeta123", [
      { ...textNode("5:1", ""), type: "FRAME", name: "Checkout" },
      textNode("5:2", "The checkout button is hidden below the fold on small screens, so people miss it."),
    ]);
    data.clusters = [{ ...data.clusters[0]!, nodeIds: ["5:1", "5:2"], confirmedNodeIds: ["5:1", "5:2"] }];
    setBoard(data.boardId, data);
    const output = await getBoardContext({ boardId: data.boardId, topic: "checkout" });
    expect(output.evidence.map((item) => [item.nodeId, item.sourceType])).toEqual([["5:2", "board_text"], ["5:1", "board_metadata"]]);
  });

  it("drops the overview and page position before failing on a small budget", async () => {
    const output = await getBoardContext({ boardId: "Large300", maxChars: 2000 });
    expect(output.evidence.length).toBeGreaterThan(0);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(2000);
    expect(output.contextText).not.toContain("Board overview");
  });

  it("keeps the parent table of a cell", async () => {
    const data = evidenceBoard("TableKeep123", [{ ...textNode("10:1", "Budget\n999"), name: "Table 1", type: "TABLE", table: { cells: [
      { id: "label", text: "Budget", row: 0, column: 0 },
    ] } }]);
    setBoard(data.boardId, data);
    const output = await getBoardContext({ boardId: data.boardId });
    expect(output.evidence[0]).toMatchObject({ nodeId: "label", renderNodeId: "10:1", nodeName: "Table 1" });
    expect(output.contextText).toContain("Node name: Table 1; Table node: 10:1; Row index: 0; Column index: 0");
  });
});
