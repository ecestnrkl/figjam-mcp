import { beforeEach, describe, expect, it } from "vitest";
import { setBoard } from "../src/lib/cache.js";
import { getBoardContext } from "../src/tools/getBoardContext.js";
import { getBoardContextInputSchema, getBoardContextOutputSchema, type GetBoardContextInput } from "../src/schemas/getBoardContext.js";
import { evidenceBoard, textNode } from "./fixtures/retrieval.js";
import { largeBoard, tableBoard } from "./fixtures/largeBoard.js";
import { retrieveEvidence } from "../src/lib/evidence.js";
import { sectionGuide } from "../src/lib/sections.js";
import { flattenNodeTree, isGenericNodeName } from "../src/lib/nodeTree.js";
import { partitionedBoardClusters } from "../src/lib/spatialCluster.js";
import type { BoardData } from "../src/types.js";

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
    const { text, structuredContent: output } = await getBoardContext({ boardId: "Context123" });
    expect(text).toContain("Node name: Interview notes");
    expect(text).toContain("Node name: Calendar sketch");
    expect(text).toContain("## Cluster: User research");
    expect(text).toContain("## Connections between clusters");
    expect(text).toContain('"User research" → "Prototype ideas" — "inspires"');
    expect(output.evidence).toHaveLength(2);
    for (const item of output.evidence) {
      expect(text).toContain(`[${item.evidenceId}] original · node ${item.nodeId} · ${item.url}`);
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
    const { text, structuredContent: output } = await getBoardContext({ boardId: "Topic123", topic: "interview quotes" });
    expect(output.clusters).toHaveLength(2);
    expect(output.evidence[0]?.text).toContain("Interview quotes");
    expect(output.evidence.map((item) => item.nodeId)).toEqual(["1:1", "1:2"]);
    expect(text).toContain("1:1 → 1:2 (inspires)");
    expect(text).not.toContain("Brand campaign");
    expect(output.connections.map((item) => item.connectorId)).toEqual(["2:1"]);
    expect(output.totalMatched).toBe(2);
  });

  it("marks a model summary even when only the conflicting original source matches the topic", async () => {
    const data = evidenceBoard("SummaryOrigin123", [textNode("1:1", "The launch is Tuesday.")]);
    data.clusters[0]!.summarySource = "vision_llm";
    data.clusters[0]!.summary = "The launch is Friday.";
    setBoard(data.boardId, data);
    const { structuredContent: output } = await getBoardContext({ boardId: data.boardId, topic: "Tuesday" });
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
    const { structuredContent: output } = await getBoardContext({ boardId: data.boardId });
    expect(output.clusters[0]).toMatchObject({ summary: "", summarySource: "deterministic", modelDerived: false });
    expect(output.clusters[1]).toMatchObject({ summarySource: "cache", modelDerived: true });
  });

  it("paginates focused results and their graph neighbors without losing or repeating evidence", async () => {
    setBoard("NeighborPaging123", board("NeighborPaging123"));
    const { structuredContent: first } = await getBoardContext({ boardId: "NeighborPaging123", topic: "interview", limit: 1 });
    expect(first.evidence.map((item) => item.nodeId)).toEqual(["1:1"]);
    expect(first.totalMatched).toBe(2);
    const { structuredContent: second } = await getBoardContext({ boardId: "NeighborPaging123", topic: "interview", limit: 1, cursor: first.nextCursor });
    expect(second.evidence.map((item) => item.nodeId)).toEqual(["1:2"]);
    expect(second.nextCursor).toBeUndefined();
    expect(second.truncation.remainingEvidence).toBe(0);
  });

  it("paginates a table label and its separately stored value as distinct source excerpts", async () => {
    // The cell without a row keeps this table at cell excerpts.
    const data = evidenceBoard("TablePaging123", [{ ...textNode("10:1", "Budget\n999"), name: "Table 1", type: "TABLE", table: { cells: [
      { id: "label", text: "Budget", row: 0, column: 0 },
      { id: "value", text: "999", row: 0, column: 1 },
      { id: "loose", text: "Loose note" },
    ] } }]);
    setBoard(data.boardId, data);
    const { structuredContent: first } = await getBoardContext({ boardId: data.boardId, topic: "Budget", limit: 1 });
    expect(first.evidence.map(item => item.text)).toEqual(["Budget"]);
    expect(first.totalMatched).toBe(2);
    expect(first.nextCursor).toBeDefined();
    const { text, structuredContent: second } = await getBoardContext({ boardId: data.boardId, topic: "Budget", limit: 1, cursor: first.nextCursor });
    expect(second.evidence.map(item => item.text)).toEqual(["999"]);
    expect(text).toContain("Table node: 10:1; Row index: 0; Column index: 1");
    expect(second.nextCursor).toBeUndefined();
  });

  it("does not turn a missing topic into a full-board disclosure", async () => {
    setBoard("Missing123", board("Missing123"));
    const { text, structuredContent: output } = await getBoardContext({ boardId: "Missing123", topic: "quantum reactor" });
    expect(output).toMatchObject({ evidence: [], clusters: [], connections: [], totalMatched: 0, truncated: false });
    for (const shown of [text, output.contextText]) {
      expect(shown).toContain("No source evidence matched");
      expect(shown).not.toContain("Interview quotes");
    }
    expect(output.contextText).not.toContain("Excerpts are in evidence");
  });

  it("supports node lookup and rejects simultaneous topic and nodeIds", async () => {
    setBoard("Lookup123", board("Lookup123"));
    const { structuredContent: output } = await getBoardContext({ boardId: "Lookup123", nodeIds: ["1:2"] });
    expect(output.evidence.map((item) => item.nodeId)).toEqual(["1:2"]);
    await expect(getBoardContext({ boardId: "Lookup123", nodeIds: ["1:2"], topic: "calendar" })).rejects.toThrow(/either topic or nodeIds/);
  });

  it("shows the original source name that explains a metadata-only match", async () => {
    const data = evidenceBoard("NamedOwner123", [{ ...textNode("1:1", "Ada"), name: "Escalation owner" }]);
    setBoard(data.boardId, data);
    const { text, structuredContent: output } = await getBoardContext({ boardId: data.boardId, topic: "Escalation owner" });
    expect(output.evidence[0]).toMatchObject({ text: "Ada", nodeName: "Escalation owner", modelDerived: false });
    expect(text).toContain("Node name: Escalation owner");
    expect(text).toContain("\nAda");
  });

  it("covers different clusters before more excerpts from one large area", async () => {
    const data = evidenceBoard("Coverage123", Array.from({ length: 12 }, (_, i) => textNode(`1:${i}`, `Research note ${i}.`)));
    data.clusters = [
      { ...data.clusters[0]!, id: "large", label: "Large area", nodeIds: data.nodes.slice(0, 10).map((node) => node.id), confirmedNodeIds: data.nodes.slice(0, 10).map((node) => node.id) },
      { ...data.clusters[10]!, id: "small-a", label: "Small area A" },
      { ...data.clusters[11]!, id: "small-b", label: "Small area B" },
    ];
    setBoard(data.boardId, data);
    const { structuredContent: output } = await getBoardContext({ boardId: data.boardId, limit: 3 });
    expect(output.evidence.map((item) => item.nodeId)).toEqual(["1:0", "1:10", "1:11"]);
    expect(output.clusters).toHaveLength(3);
  });

  it("renders arrows within a cluster and reports connection omissions explicitly", async () => {
    const data = board("Arrows123");
    data.clusters = [{ ...data.clusters[0]!, nodeIds: ["1:1", "1:2"], confirmedNodeIds: ["1:1", "1:2"] }];
    data.clusterRelations = [];
    data.connectorEdges = Array.from({ length: 150 }, (_, i) => ({ connectorId: `2:${i}`, fromNodeId: "1:1", toNodeId: "1:2", direction: "reverse", label: `depends on ${i}` }));
    setBoard(data.boardId, data);
    const { text, structuredContent: output } = await getBoardContext({ boardId: data.boardId, maxChars: 4000 });
    expect(text).toContain("1:1 ← 1:2");
    expect(text).toContain("Interview quotes about planning problems.");
    expect(text).toContain("Sketches for a calendar assistant.");
    expect(output.connections.length).toBeGreaterThan(0);
    expect(output.truncation.omittedConnections).toBe(150 - output.connections.length);
    expect(output.truncation.omittedTextConnections).toBe(150 - output.connections.length);
    expect(output.truncated).toBe(true);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(4000);
    expect(text.length).toBeLessThanOrEqual(4000);
    const { structuredContent: roomy } = await getBoardContext({ boardId: data.boardId, maxChars: 24000 });
    expect(roomy.connections).toHaveLength(100);
    expect(roomy.truncation.omittedConnections).toBe(50);
  });

  it("paginates without duplicate IDs or omitted excerpts and pins the snapshot", async () => {
    const data = evidenceBoard("Paging123", Array.from({ length: 12 }, (_, index) => textNode(`1:${index}`, `Unique note ${index}. ${"detail ".repeat(130)}`)));
    setBoard(data.boardId, data);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const { text, structuredContent: output } = await getBoardContext({ boardId: data.boardId, limit: 3, maxChars: 3000, cursor });
      expect(text.length).toBeLessThanOrEqual(3000);
      expect(JSON.stringify(output).length).toBeLessThanOrEqual(3000);
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
    const { structuredContent: first } = await getBoardContext({ boardId: "Cursor123", limit: 1 });
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
    const { structuredContent: first } = await getBoardContext({ boardId: data.boardId, limit: 1 });
    const refined = structuredClone(data);
    refined.clusters[0]!.summary = "The visual interpretation contains a green button.";
    setBoard(data.boardId, refined);
    await expect(getBoardContext({ boardId: data.boardId, limit: 1, cursor: first.nextCursor })).rejects.toThrow(/results changed/);
  });

  it("bounds the complete MCP response, including UTF-8 bytes and duplicated readable content", async () => {
    const data = evidenceBoard("Budget123", Array.from({ length: 200 }, (_, index) => textNode(`1:${index}`, "界".repeat(1000))));
    data.clusters.forEach((cluster) => { cluster.summary = "界".repeat(3000); });
    setBoard(data.boardId, data);
    const { text, structuredContent: output } = await getBoardContext({ boardId: data.boardId, limit: 100, maxChars: 24000 });
    const bytes = Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text }], structuredContent: output }));
    expect(bytes).toBeLessThanOrEqual(128 * 1024);
    expect(text.length).toBeLessThanOrEqual(24000);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(24000);
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

  it("rejects outsideSections together with topic or nodeIds, also in the handler", async () => {
    setBoard("Lookup123", board("Lookup123"));
    for (const input of [{ topic: "calendar" }, { nodeIds: ["1:2"] }]) {
      expect(getBoardContextInputSchema.safeParse({ boardId: "Lookup123", outsideSections: true, ...input }).success).toBe(false);
      await expect(getBoardContext({ boardId: "Lookup123", outsideSections: true, ...input })).rejects.toThrow(/outsideSections without topic or nodeIds/);
      expect(getBoardContextInputSchema.safeParse({ boardId: "Lookup123", outsideSections: false, ...input }).success).toBe(true);
    }
  });
});

describe("getBoardContext response size", () => {
  beforeEach(() => setBoard("Large300", largeBoard("Large300")));

  it("keeps the whole structured response within maxChars on a large board", async () => {
    for (const input of [{}, { limit: 100, maxChars: 24000 }]) {
      const { text, structuredContent: output } = await getBoardContext({ boardId: "Large300", ...input });
      expect(JSON.stringify(output).length).toBeLessThanOrEqual(input.maxChars ?? 12000);
      expect(text.length).toBeLessThanOrEqual(input.maxChars ?? 12000);
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
      const { structuredContent: output } = await getBoardContext({ boardId: data.boardId, limit: 100, maxChars: 24000, cursor });
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
    expect(overview.structuredContent.evidence[0]).toMatchObject({ nodeId: "9:1", chunkIndex: 0, truncated: true });
    expect(overview.text).toContain('Part 1 of 3 — request get_board_context with nodeIds: ["9:1"] for all parts.');
    expect(overview.text).not.toContain("use the source link");
    const lookup = await getBoardContext({ boardId: data.boardId, nodeIds: ["9:1"] });
    expect(lookup.structuredContent.evidence.map((item) => item.chunkIndex)).toEqual([0, 1, 2]);
    expect(lookup.structuredContent.evidence.map((item) => item.text).join(" ")).toContain("Long workshop protocol sentence.");
    expect(lookup.text).toContain("[Part 3 of 3.]");
  });

  it("shortens a first excerpt that alone exceeds the budget instead of failing", async () => {
    const data = evidenceBoard("Shorten123", [textNode("9:2", "evidence ".repeat(140))]);
    setBoard(data.boardId, data);
    const { text, structuredContent: output } = await getBoardContext({ boardId: data.boardId, maxChars: 1500 });
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(1500);
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(output.evidence).toHaveLength(1);
    expect(output.evidence[0]!.text.length).toBeLessThan(1200);
    expect(output.truncated).toBe(true);
    expect(text).toContain('Shortened to fit maxChars. Part 1 of 2 — request get_board_context with nodeIds: ["9:2"] for all parts.');
  });

  it("shows the board overview only on the first page of an unfocused request", async () => {
    const { structuredContent: first } = await getBoardContext({ boardId: "Large300" });
    expect(first.contextText).toContain("## Board overview");
    expect(first.contextText).toContain("300 clusters, 3030 excerpts.");
    expect(first.contextText).toMatch(/- 1:0 Theme 1 — \d+ excerpts\n- 1:1 Theme 2 — \d+ excerpts/);
    expect(first.contextText).toContain('Read a section with nodeIds: ["<ID>"]; use topic for word search.');
    expect(first.contextText).toContain("With more than 5 pages left, read sections by ID instead");
    const second = await getBoardContext({ boardId: "Large300", cursor: first.nextCursor });
    const topic = await getBoardContext({ boardId: "Large300", topic: "onboarding mobile" });
    const nodes = await getBoardContext({ boardId: "Large300", nodeIds: ["10:0"] });
    for (const output of [second, topic, nodes]) expect(output.text).not.toContain("Board overview");
    expect(topic.text).not.toContain("read sections by ID instead");
  });

  it("does not repeat node names that open the text and keeps model interpretations marked", async () => {
    const data = largeBoard("Names123", 3, 4, 1);
    data.clusters[1]!.summarySource = "vision_llm";
    data.clusters[1]!.summary = "The photo shows a whiteboard with a crossed-out checkout flow.";
    setBoard(data.boardId, data);
    const { text, structuredContent: output } = await getBoardContext({ boardId: data.boardId });
    const sticky = "Participant 0-1 said onboarding step 1 feels slow on mobile.";
    expect(text.split(sticky)).toHaveLength(2);
    expect(JSON.stringify(output).split(sticky)).toHaveLength(2);
    expect(text).not.toContain("Node name: Participant");
    const original = output.evidence.find((item) => item.text === sticky)!;
    expect(original).not.toHaveProperty("nodeName");
    for (const field of ["pageId", "sectionIds", "clusterId", "clusterLabel", "renderNodeId", "pageName", "sectionNames"]) {
      expect(original).not.toHaveProperty(field);
    }
    const interpretation = output.evidence.find((item) => item.sourceType === "model_interpretation")!;
    expect(interpretation).toMatchObject({ modelDerived: true });
    expect(text).toContain(`[${interpretation.evidenceId}] MODEL INTERPRETATION — verify against original`);
    expect(output.clusters.find((cluster) => cluster.summarySource === "vision_llm")?.summary)
      .toBe("The photo shows a whiteboard with a crossed-out checkout flow.");
    expect(output.clusters.find((cluster) => cluster.summarySource === "deterministic")?.summary).toBe("");
    expect(text.match(/## Cluster: /g)).toHaveLength(3);
    expect(text).toContain("## Cluster: Participant 0-0 said onboarding step\nPage: Workshop; Sections: Theme 1");
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
    const { structuredContent: output } = await getBoardContext({ boardId: "Large300" });
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
    const { structuredContent: output } = await getBoardContext({ boardId: data.boardId, topic: "checkout" });
    expect(output.evidence.map((item) => [item.nodeId, item.sourceType])).toEqual([["5:2", "board_text"], ["5:1", "board_metadata"]]);
  });

  it("drops the overview and page position before failing on a small budget", async () => {
    const { text, structuredContent: output } = await getBoardContext({ boardId: "Large300", maxChars: 2000 });
    expect(output.evidence.length).toBeGreaterThan(0);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(2000);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(output.contextText).not.toContain("Board overview");
  });

  it("keeps the parent table of a cell", async () => {
    const data = evidenceBoard("TableKeep123", [{ ...textNode("10:1", "Budget\n999"), name: "Table 1", type: "TABLE", table: { cells: [
      { id: "label", text: "Budget", row: 0, column: 0 },
      { id: "loose", text: "Loose note" },
    ] } }]);
    setBoard(data.boardId, data);
    const { text, structuredContent: output } = await getBoardContext({ boardId: data.boardId });
    expect(output.evidence[0]).toMatchObject({ nodeId: "label", renderNodeId: "10:1", nodeName: "Table 1" });
    expect(text).toContain("Node name: Table 1; Table node: 10:1; Row index: 0; Column index: 0");
  });
});

describe("getBoardContext text and structured content", () => {
  beforeEach(() => setBoard("Large300", largeBoard("Large300")));

  it("sends excerpt text once in structuredContent and the full readable page as text", async () => {
    setBoard("Readable123", board("Readable123"));
    const { text, structuredContent: output } = await getBoardContext({ boardId: "Readable123" });
    expect(output.evidence).toHaveLength(2);
    for (const item of output.evidence) {
      expect(output.contextText).not.toContain(item.text);
      expect(text).toContain(`[${item.evidenceId}] original · node ${item.nodeId} · ${item.url}`);
      expect(JSON.stringify(output).split(item.text)).toHaveLength(2);
    }
    for (const part of ["## Cluster:", "## Source connections", "## Connections between clusters"]) {
      expect(text).toContain(part);
      expect(output.contextText).not.toContain(part);
    }
    expect(output.contextText).toContain("Excerpts are in evidence, cluster by cluster; location and summary per cluster are in clusters");

    const first = await getBoardContext({ boardId: "Large300" });
    const orientation = first.structuredContent.contextText.split("\n\n").filter((block) => !block.startsWith("Excerpts are in evidence"));
    expect(orientation.join("\n\n")).toMatch(/Page 1 of about \d+[\s\S]*## Board overview/);
    expect(first.text.startsWith(orientation.join("\n\n"))).toBe(true);
    for (const item of first.structuredContent.evidence) {
      expect(first.text).toContain(item.text);
      expect(first.structuredContent.contextText).not.toContain(item.text);
    }
  });

  it("keeps the text and the structured result within maxChars and the whole response within 128 KiB", async () => {
    const wide = evidenceBoard("Wide123", Array.from({ length: 200 }, (_, index) => textNode(`1:${index}`, "界".repeat(1000))));
    setBoard(wide.boardId, wide);
    const outside = largeBoard("Outside123", 300, 10, 12, { outsideClusters: 12 });
    setBoard(outside.boardId, outside);
    const requests = [
      { boardId: "Large300" }, { boardId: "Large300", limit: 100 }, { boardId: "Large300", nodeIds: ["1:11"], limit: 100 },
      { boardId: "Large300", nodeIds: ["1:11", "1:10", "1:9", "1:8", "1:7", "1:6", "1:5", "1:0"], limit: 100 },
      { boardId: wide.boardId, limit: 100 }, { boardId: outside.boardId, outsideSections: true }, { boardId: outside.boardId, outsideSections: true, limit: 100 },
    ];
    for (const request of requests) {
      for (const maxChars of [512, 2000, 12000, 24000]) {
        const result = await getBoardContext({ ...request, maxChars }).catch((error: unknown) => error);
        if (result instanceof Error) {
          // A budget too small for one excerpt is refused, never exceeded.
          expect(maxChars).toBe(512);
          expect(result.message).toMatch(/cannot fit one source excerpt/);
          continue;
        }
        const { text, structuredContent } = result as Awaited<ReturnType<typeof getBoardContext>>;
        expect(structuredContent.evidence.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThanOrEqual(maxChars);
        expect(JSON.stringify(structuredContent).length).toBeLessThanOrEqual(maxChars);
        expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text }], structuredContent }))).toBeLessThanOrEqual(128 * 1024);
      }
    }
  });

  it("fits more excerpts on a page than 0.7.0", async () => {
    // 0.7.0 returned 11, 25 and 17 excerpts for these requests; 0.8.0 fit 40 on the second page,
    // which since 0.9.0 also states how many excerpts the largest sections hold.
    const pages: Array<[Omit<GetBoardContextInput, "boardId">, number]> = [
      [{}, 18], [{ limit: 100, maxChars: 24000 }, 39], [{ nodeIds: ["1:11"], limit: 100 }, 27],
    ];
    for (const [request, minimum] of pages) {
      const { structuredContent } = await getBoardContext({ boardId: "Large300", ...request });
      expect(structuredContent.evidence.length).toBeGreaterThanOrEqual(minimum);
    }
  });

  it("states the location once per cluster and on an excerpt only outside a cluster or where it differs", async () => {
    const container = (id: string, name: string, type: string) =>
      ({ id, name, type, x: 0, y: 0, width: 0, height: 0, rotation: 0, ...(type === "SECTION" ? { pageId: "0:1" } : {}) });
    const data = evidenceBoard("Location123", [
      { ...textNode("2:1", "First research note."), sectionIds: ["1:0"] },
      { ...textNode("2:2", "Second research note."), sectionIds: ["1:0"] },
      { ...textNode("2:3", "An idea filed under research."), sectionIds: ["1:9"] },
      { ...textNode("2:4", "A note beside the sections."), sectionIds: undefined },
      { ...textNode("2:5", "A note outside every cluster."), sectionIds: ["1:9"] },
    ]);
    data.nodes.push(container("0:1", "Workshop", "CANVAS"), container("1:0", "Research", "SECTION"), container("1:9", "Ideas", "SECTION"));
    data.clusters = [{ ...data.clusters[0]!, label: "Research cluster", nodeIds: ["2:1", "2:2", "2:3", "2:4"], confirmedNodeIds: ["2:1", "2:2", "2:3", "2:4"] }];
    setBoard(data.boardId, data);
    const { text, structuredContent: output } = await getBoardContext({ boardId: data.boardId });
    expect(output.clusters).toEqual([expect.objectContaining({ label: "Research cluster", pageName: "Workshop", sectionNames: ["Research"] })]);
    const location = (nodeId: string) => {
      const { pageName, sectionNames } = output.evidence.find((item) => item.nodeId === nodeId)!;
      return { pageName, sectionNames };
    };
    expect(location("2:1")).toEqual({ pageName: undefined, sectionNames: undefined });
    expect(location("2:2")).toEqual({ pageName: undefined, sectionNames: undefined });
    expect(location("2:3")).toEqual({ pageName: "Workshop", sectionNames: ["Ideas"] });
    expect(location("2:4")).toEqual({ pageName: "Workshop", sectionNames: [] });
    expect(location("2:5")).toEqual({ pageName: "Workshop", sectionNames: ["Ideas"] });
    expect(getBoardContextOutputSchema.safeParse(output).success).toBe(true);
    expect(text).toContain("## Outside clusters\nPage: Workshop; Sections: Ideas");
    expect(text).toContain("Page: Workshop; Sections: Ideas\nAn idea filed under research.");
  });

  it("orders evidence cluster by cluster like the text and pages through every excerpt once", async () => {
    const data = evidenceBoard("Order123", Array.from({ length: 9 }, (_, index) => textNode(`1:${index}`, `Order note ${index}.`)));
    data.clusters = ["A", "B", "C"].map((label, index) => {
      const nodeIds = data.nodes.slice(index * 3, index * 3 + 3).map((node) => node.id);
      return { ...data.clusters[index]!, id: `cluster_${label}`, label: `Cluster ${label}`, nodeIds, confirmedNodeIds: nodeIds };
    });
    setBoard(data.boardId, data);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const { text, structuredContent: output } = await getBoardContext({ boardId: data.boardId, limit: 4, cursor });
      const clusterOf = (nodeId: string) => data.clusters.find((cluster) => cluster.nodeIds.includes(nodeId))!.label;
      const order = output.evidence.map((item) => clusterOf(item.nodeId));
      // Each cluster forms one block, in the order of the clusters list and of the text.
      expect(order).toEqual([...order].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
      expect(output.clusters.map((cluster) => cluster.label)).toEqual([...new Set(order)]);
      const positions = output.evidence.map((item) => text.indexOf(`[${item.evidenceId}]`));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      seen.push(...output.evidence.map((item) => item.evidenceId));
      cursor = output.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
    // The first page takes the first excerpt of each cluster, then groups them.
    const first = await getBoardContext({ boardId: data.boardId, limit: 4 });
    expect(first.structuredContent.evidence.map((item) => item.nodeId)).toEqual(["1:0", "1:1", "1:3", "1:6"]);
  });
});

function sectionBoard(boardId: string): BoardData {
  const box = (x: number, y: number, width = 100, height = 100) => ({ absoluteBoundingBox: { x, y, width, height } });
  const sticky = (id: string, text: string, x: number, y: number) => ({ id, name: text, type: "STICKY", characters: text, ...box(x, y) });
  const nodes = flattenNodeTree({ document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [
    { id: "0:1", name: "Board A", type: "CANVAS", children: [
      { id: "1:1", name: "Research", type: "SECTION", ...box(0, 0, 3000, 2000), children: [
        sticky("2:1", "Alpha lower", 0, 500),
        { id: "1:2", name: " ", type: "SECTION", ...box(0, 1000, 1000, 500), children: [sticky("2:3", "Nested note", 0, 1100)] },
        sticky("2:2", "Alpha upper", 2000, 0),
      ] },
      { id: "1:3", name: "Journey", type: "FRAME", ...box(5000, 0, 1000, 1000), children: [
        sticky("2:4", "Frame note", 5000, 0),
        { id: "1:4", name: "Group 1", type: "GROUP", ...box(5000, 600, 100, 100), children: [sticky("2:5", "Group note", 5000, 600)] },
      ] },
      sticky("2:6", "Outside note", 9000, 0),
    ] },
    { id: "0:2", name: "Board B", type: "CANVAS", children: [sticky("2:7", "Other page note", 0, 0)] },
  ] } });
  return {
    boardId, fileKey: boardId, docStructureHint: "freeform", createdAt: 1, snapshotId: "d".repeat(64), nodes,
    clusters: partitionedBoardClusters(nodes).map((cluster) => ({ ...cluster, label: `Area ${cluster.nodeIds.join(" ")}`,
      summary: "Deterministic summary.", confirmedNodeIds: cluster.nodeIds, summarySource: "deterministic" as const })),
  };
}

// Cluster by cluster, top to bottom, then left to right; name-only metadata last.
const PAGE_A_READING_ORDER = ["Alpha upper", "Frame note", "Outside note", "Alpha lower", "Group note", "Nested note", "Journey"];

describe("getBoardContext by section", () => {
  beforeEach(() => setBoard("Sections123", sectionBoard("Sections123")));
  const texts = ({ structuredContent }: { structuredContent: { evidence: Array<{ text: string }> } }) =>
    structuredContent.evidence.map((item) => item.text);

  it("reads every excerpt inside a section, frame, group or page in reading order, nested sections included", async () => {
    const section = await getBoardContext({ boardId: "Sections123", nodeIds: ["1:1"] });
    expect(texts(section)).toEqual(["Alpha upper", "Alpha lower", "Nested note"]);
    const frame = await getBoardContext({ boardId: "Sections123", nodeIds: ["1:3"] });
    expect(texts(frame)).toEqual(["Frame note", "Group note", "Journey"]);
    expect(frame.structuredContent.evidence.at(-1)).toMatchObject({ nodeId: "1:3", sourceType: "board_metadata" });
    expect(texts(await getBoardContext({ boardId: "Sections123", nodeIds: ["1:4"] }))).toEqual(["Group note"]);
    const page = await getBoardContext({ boardId: "Sections123", nodeIds: ["0:1"] });
    expect(texts(page)).toEqual(PAGE_A_READING_ORDER);
    expect(texts(await getBoardContext({ boardId: "Sections123", nodeIds: ["0:2"] }))).toEqual(["Other page note"]);
    // Leaf nodes are unchanged.
    expect(texts(await getBoardContext({ boardId: "Sections123", nodeIds: ["2:1"] }))).toEqual(["Alpha lower"]);
  });

  it("lists direct subsections with IDs on the first page and pages through the rest with the cursor", async () => {
    const { structuredContent: section } = await getBoardContext({ boardId: "Sections123", nodeIds: ["1:1"] });
    expect(section.contextText).toContain("## Sections inside (ID, name, excerpts)\n- In 1:1 Research:\n  - 1:2 (unnamed section) — 1 excerpt");
    const first = await getBoardContext({ boardId: "Sections123", nodeIds: ["0:1"], limit: 2 });
    expect(first.structuredContent.contextText).toContain("  - 1:1 Research — 3 excerpts");
    expect(first.structuredContent.contextText).not.toContain("1:2 (unnamed section)");
    const seen = texts(first);
    let cursor = first.structuredContent.nextCursor;
    while (cursor) {
      const next = await getBoardContext({ boardId: "Sections123", nodeIds: ["0:1"], limit: 2, cursor });
      expect(next.text).not.toContain("## Sections inside");
      seen.push(...texts(next));
      cursor = next.structuredContent.nextCursor;
    }
    expect(seen).toEqual(PAGE_A_READING_ORDER);
  });

  it("returns only and all excerpts of a section for its ID", async () => {
    const data = largeBoard("Theme300", 300, 10, 12, { subsections: 2 });
    setBoard(data.boardId, data);
    const sectionOf = new Map(data.nodes.map((node) => [node.id, node.sectionIds?.[0]]));
    const { structuredContent: byId } = await getBoardContext({ boardId: data.boardId, nodeIds: ["1:5"], limit: 100, maxChars: 24000 });
    expect(byId.evidence.length).toBeGreaterThan(0);
    expect(byId.evidence.filter((item) => sectionOf.get(item.nodeId) === "1:5")).toHaveLength(byId.evidence.length);
    expect(byId.clusters.every((cluster) => cluster.sectionNames?.[0] === "Theme 6")).toBe(true);
    expect(byId.totalMatched).toBe(retrieveEvidence(data).evidence
      .filter((item) => item.sectionIds?.[0] === "1:5").length);
  });

  it("shows every section as a tree with IDs, unnamed sections and the excerpts outside sections", async () => {
    const { structuredContent: output } = await getBoardContext({ boardId: "Sections123" });
    expect(output.contextText).toContain([
      "Pages and sections in reading order (ID, name, excerpts including nested sections):",
      "- Page 0:1 Board A — 7 excerpts",
      "  - 1:1 Research — 3 excerpts",
      "    - 1:2 (unnamed section) — 1 excerpt",
      "- Page 0:2 Board B — 1 excerpt",
      "5 excerpts outside sections; read them with outsideSections: true.",
      'Read a section with nodeIds: ["<ID>"]; use topic for word search.',
    ].join("\n"));
  });

  it("counts images not yet interpreted and summarizes what exceeds a third of maxChars, deeper levels first", async () => {
    const data = largeBoard("Outline123", 120, 2, 12, { subsections: 2, imageClusters: 24 });
    setBoard(data.boardId, data);
    const { structuredContent: full } = await getBoardContext({ boardId: data.boardId, maxChars: 24000 });
    expect(full.contextText).toMatch(/- 1:0 Theme 1 — \d+ excerpts, 2 image clusters not yet interpreted/);
    expect(full.contextText).toMatch(/  - 2:0 Theme 1\.1 — \d+ excerpts/);
    expect(full.contextText).not.toContain("more sections not listed");

    const { structuredContent: shallow } = await getBoardContext({ boardId: data.boardId, maxChars: 4000 });
    expect(JSON.stringify(shallow).length).toBeLessThanOrEqual(4000);
    expect(shallow.contextText).toContain("- 1:10 Theme 11 — ");
    expect(shallow.contextText).not.toContain("2:0 Theme 1.1");
    expect(shallow.contextText).toContain("25 more sections not listed; read a listed page or section by ID");

    const many = largeBoard("Outline40", 120, 2, 40, { imageClusters: 40 });
    setBoard(many.boardId, many);
    const cut = await getBoardContext({ boardId: many.boardId, maxChars: 3000 });
    expect(JSON.stringify(cut.structuredContent).length).toBeLessThanOrEqual(3000);
    expect(cut.text.length).toBeLessThanOrEqual(3000);
    const overview = cut.text.slice(cut.text.indexOf("## Board overview"));
    expect(cut.structuredContent.contextText).toContain("## Board overview");
    expect(overview).toMatch(/\d+ more sections not listed/);
    expect(JSON.stringify(overview.slice(0, overview.indexOf("\n\n## Cluster"))).length).toBeLessThanOrEqual(Math.floor(3000 / 3) + 2);
  });

  it("names the largest sections before the tree and keeps them when the budget shortens the tree", async () => {
    setBoard("Large300", largeBoard("Large300"));
    const { contextText } = (await getBoardContext({ boardId: "Large300", maxChars: 24000 })).structuredContent;
    const line = contextText.split("\n").find((text) => text.startsWith("Largest sections (ID, name, excerpts): "))!;
    const largest = [...line.matchAll(/(\d+:\d+) (Theme \d+) — (\d+)/g)].map(([, id, name, count]) => ({ id, name, count: Number(count) }));
    expect(largest).toHaveLength(10);
    expect(largest[0]).toMatchObject({ id: "1:11", name: "Theme 12" });
    expect(largest.map(({ count }) => count)).toEqual(largest.map(({ count }) => count).sort((a, b) => b - a));
    for (const { id, name, count } of largest) expect(contextText).toContain(`- ${id} ${name} — ${count} excerpts`);
    expect(contextText.indexOf(line)).toBeLessThan(contextText.indexOf("Sections in reading order"));

    const many = largeBoard("Largest40", 120, 2, 40);
    setBoard(many.boardId, many);
    const cut = (await getBoardContext({ boardId: many.boardId, maxChars: 3000 })).structuredContent.contextText;
    expect(cut).toMatch(/\d+ more sections not listed/);
    expect(cut).toMatch(/\nLargest sections \(ID, name, excerpts\): \d+:\d+ Theme \d+ — \d+; .*\.\nSections in reading order/);
    expect(cut.match(/ — \d+[;.]/g)).toHaveLength(10);
    // Topic, nodeIds and later pages have no board overview.
    for (const request of [{ topic: "onboarding" }, { nodeIds: ["1:0"] }]) {
      expect((await getBoardContext({ boardId: "Large300", ...request })).text).not.toContain("Largest sections");
    }
  });
});

describe("getBoardContext with several requested IDs", () => {
  const data = largeBoard("Shared300", 300, 10, 12, { subsections: 2, outsideClusters: 12 });
  const all = new Map(retrieveEvidence(data).evidence.map((item) => [item.evidenceId, item]));
  // 1:0 is the smallest section and 1:11 the last in reading order.
  const EIGHT = ["1:11", "1:10", "1:9", "1:8", "1:7", "1:6", "1:5", "1:0"];
  const total = (id: string) => retrieveEvidence(data, { nodeIds: [id] }).totalMatched;
  beforeEach(() => setBoard(data.boardId, data));

  async function readSequence(nodeIds: string[]) {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const { structuredContent } = await getBoardContext({ boardId: data.boardId, nodeIds, limit: 100, maxChars: 24000, cursor });
      pages.push(structuredContent.evidence.map((item) => item.evidenceId));
      cursor = structuredContent.nextCursor;
    } while (cursor && pages.length < 200);
    return pages;
  }

  it("shows every requested section on the first page", async () => {
    expect(Math.min(...EIGHT.map(total))).toBe(total("1:0"));
    const page = retrieveEvidence(data, { nodeIds: ["0:1"] }).evidence.filter((item) => item.sectionIds?.length && item.sourceType !== "board_metadata");
    expect(page.at(-1)!.sectionIds![0]).toBe("1:11");
    for (const request of [{}, { limit: 100, maxChars: 24000 }]) {
      const { structuredContent } = await getBoardContext({ boardId: data.boardId, nodeIds: EIGHT, ...request });
      const shown = new Set(structuredContent.evidence.map((item) => all.get(item.evidenceId)!.sectionIds![0]));
      expect([...shown].sort()).toEqual([...EIGHT].sort());
      expect(structuredContent.totalMatched).toBe(EIGHT.map(total).reduce((sum, count) => sum + count));
      expect(structuredContent.contextText).toContain("## Requested IDs, which share every page (ID, name, excerpts on all pages)\n" +
        EIGHT.map((id) => `- ${id} Theme ${Number(id.slice(2)) + 1} — ${total(id)} excerpts`).join("\n"));
    }
  });

  it("takes turns with content only, so a section that opens with named frames still shows content on the first page", async () => {
    const framed = largeBoard("Framed300", 300, 10, 12, { subsections: 2, outsideClusters: 12 });
    const node = (id: string, name: string, type: string, text?: string) => ({
      id, name, type, ...(text ? { text } : {}), x: -2000, y: 0, width: 100, height: 100, rotation: 0, pageId: "0:1", sectionIds: ["1:5"],
    });
    // Named frames first in tree order, then the stickies on them, in a cluster that opens section 1:5.
    const members = [...Array.from({ length: 25 }, (_, k) => node(`6:${k}`, `Persona board ${k}`, "FRAME")),
      ...Array.from({ length: 3 }, (_, k) => node(`6:${100 + k}`, `Persona note ${k}`, "STICKY", `Persona note ${k} about trust.`))];
    framed.nodes.push(...members);
    framed.clusters.unshift({ id: "cluster_frames", label: "Persona boards", nodeIds: members.map((member) => member.id),
      confirmedNodeIds: members.map((member) => member.id), boundingBox: { x: -2000, y: 0, width: 1000, height: 1000 },
      summarySource: "deterministic", summary: "" });
    setBoard(framed.boardId, framed);
    const sectionOf = new Map(retrieveEvidence(framed).evidence.map((item) => [item.evidenceId, item.sectionIds?.[0]]));
    expect(retrieveEvidence(framed, { nodeIds: ["1:5"] }).evidence.slice(0, 3).map((item) => item.nodeId)).toEqual(["6:100", "6:101", "6:102"]);
    const { structuredContent } = await getBoardContext({ boardId: framed.boardId, nodeIds: EIGHT });
    for (const id of EIGHT) {
      expect(structuredContent.evidence.some((item) => sectionOf.get(item.evidenceId) === id && item.sourceType !== "board_metadata")).toBe(true);
    }
    // Name-only excerpts still follow all content, by requested ID.
    const sequence = retrieveEvidence(framed, { nodeIds: EIGHT }).evidence;
    const firstName = sequence.findIndex((item) => item.sourceType === "board_metadata");
    expect(sequence.slice(firstName).every((item) => item.sourceType === "board_metadata")).toBe(true);
    const owners = sequence.slice(firstName).map((item) => EIGHT.indexOf(sectionOf.get(item.evidenceId)!));
    expect(owners).toEqual([...owners].sort((a, b) => a - b));
  });

  it("counts each excerpt once, for the innermost requested section, with parent and child on the first page", async () => {
    const pages = await readSequence(["1:11", "2:1100"]);
    const sequence = pages.flat();
    expect(sequence).toHaveLength(total("1:11"));
    expect(new Set(sequence).size).toBe(sequence.length);
    const inChild = (id: string) => all.get(id)!.sectionIds!.includes("2:1100");
    expect(pages[0]!.some(inChild)).toBe(true);
    expect(pages[0]!.some((id) => !inChild(id))).toBe(true);
    const { contextText } = (await getBoardContext({ boardId: data.boardId, nodeIds: ["1:11", "2:1100"] })).structuredContent;
    expect(contextText).toContain(`- 1:11 Theme 12 — ${total("1:11") - total("2:1100")} excerpts\n- 2:1100 Theme 12.1 — ${total("2:1100")} excerpts`);
  });

  it("takes turns in request order, which belongs to the cursor", async () => {
    const forward = await getBoardContext({ boardId: data.boardId, nodeIds: ["1:3", "1:9"] });
    const backward = await getBoardContext({ boardId: data.boardId, nodeIds: ["1:9", "1:3", "1:9"] });
    const sectionOf = (output: typeof forward) => all.get(output.structuredContent.evidence[0]!.evidenceId)!.sectionIds![0];
    expect(retrieveEvidence(data, { nodeIds: ["1:3", "1:9"] }).evidence[0]!.sectionIds![0]).toBe("1:3");
    expect(retrieveEvidence(data, { nodeIds: ["1:9", "1:3"] }).evidence[0]!.sectionIds![0]).toBe("1:9");
    expect(forward.structuredContent.evidence[0]!.evidenceId).not.toBe(backward.structuredContent.evidence[0]!.evidenceId);
    expect(new Set([sectionOf(forward), sectionOf(backward)])).toEqual(new Set(["1:3", "1:9"]));
    await expect(getBoardContext({ boardId: data.boardId, nodeIds: ["1:9", "1:3"], cursor: forward.structuredContent.nextCursor }))
      .rejects.toThrow(/Cursor does not match/);
    // A repeated ID does not change the query.
    const next = await getBoardContext({ boardId: data.boardId, nodeIds: ["1:9", "1:3"], cursor: backward.structuredContent.nextCursor });
    expect(next.structuredContent.evidence.length).toBeGreaterThan(0);
  });

  it("keeps the reading order of one section and the index order of a list of nodes", async () => {
    const stickies = data.nodes.filter((node) => node.sectionIds?.[0] === "1:5" && node.type === "STICKY").map((node) => node.id);
    const journeyMaps = data.nodes.filter((node) => node.sectionIds?.[0] === "1:5" && node.name.startsWith("Journey map")).map((node) => node.id);
    // The result sequence that the cursor walks; each page groups its part by cluster.
    const sequence = (nodeIds: string[]) => retrieveEvidence(data, { nodeIds }).evidence.map((item) => item.nodeId);
    expect(sequence(["1:5"])).toEqual([...stickies, ...journeyMaps]);
    expect(sequence(["12:3", "10:1", "11:0"])).toEqual(["10:1", "11:0", "12:3"]);
    expect((await readSequence(["1:5"])).flat()).toHaveLength(stickies.length + journeyMaps.length);
    const { structuredContent } = await getBoardContext({ boardId: data.boardId, nodeIds: ["12:3", "10:1"] });
    expect(structuredContent.contextText).not.toContain("## Requested IDs");
  });
});

describe("getBoardContext outside sections", () => {
  const data = largeBoard("Outside300", 300, 10, 12, { subsections: 2, outsideClusters: 12 });
  const all = new Map(retrieveEvidence(data).evidence.map((item) => [item.evidenceId, item]));
  const outside = [...all.values()].filter((item) => !item.sectionIds?.length);
  beforeEach(() => setBoard(data.boardId, data));

  it("reads every excerpt outside sections once, cluster by cluster, with the rows of a table together", async () => {
    expect(outside.filter((item) => item.sourceType === "table_row")).toHaveLength(30);
    const sequence = retrieveEvidence(data, { outsideSections: true }).evidence;
    const rows = sequence.flatMap((item, position) => item.sourceType === "table_row" ? [position] : []);
    expect(rows.at(-1)! - rows[0]!).toBe(rows.length - 1);
    const firstRowId = sequence[rows[0]!]!.evidenceId;
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { text, structuredContent } = await getBoardContext({ boardId: data.boardId, outsideSections: true, cursor });
      expect(structuredContent.totalMatched).toBe(outside.length);
      expect(text.length).toBeLessThanOrEqual(12000);
      expect(JSON.stringify(structuredContent).length).toBeLessThanOrEqual(12000);
      const shown = structuredContent.evidence;
      expect(shown.every((item) => !all.get(item.evidenceId)!.sectionIds?.length)).toBe(true);
      const tableRows = shown.filter((item) => item.sourceType === "table_row");
      if (pages > 0 && tableRows.length) expect(tableRows[0]!.evidenceId).toBe(firstRowId);
      seen.push(...shown.map((item) => item.evidenceId).filter((id) => id !== firstRowId || !seen.includes(id)));
      cursor = structuredContent.nextCursor;
      pages++;
    } while (cursor && pages < 100);
    expect(cursor).toBeUndefined();
    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(outside.length);
    expect(new Set(seen)).toEqual(new Set(outside.map((item) => item.evidenceId)));
  });

  it("names the excerpts and clusters outside sections on the first page only", async () => {
    const first = await getBoardContext({ boardId: data.boardId, outsideSections: true });
    expect(first.structuredContent.contextText).toContain(`## Outside sections\n${outside.length} excerpts in 12 clusters lie outside sections`);
    expect(first.text).not.toContain("## Board overview");
    expect(first.text).not.toContain("read sections by ID instead");
    const second = await getBoardContext({ boardId: data.boardId, outsideSections: true, cursor: first.structuredContent.nextCursor });
    expect(second.text).not.toContain("## Outside sections");
    // outsideSections belongs to the query of the cursor.
    await expect(getBoardContext({ boardId: data.boardId, cursor: first.structuredContent.nextCursor })).rejects.toThrow(/Cursor does not match/);
  });

  it("reads all excerpts of a board without sections", async () => {
    const plain = largeBoard("NoSections123", 30, 4, 2, { outsideClusters: 3 });
    plain.nodes = plain.nodes.filter((node) => node.type !== "SECTION").map(({ sectionIds: _sectionIds, ...node }) => node);
    setBoard(plain.boardId, plain);
    const { structuredContent } = await getBoardContext({ boardId: plain.boardId, outsideSections: true, limit: 100, maxChars: 24000 });
    expect(structuredContent.totalMatched).toBe(retrieveEvidence(plain).evidence.length);
    expect(structuredContent.contextText).toContain(`The board has no sections: all ${structuredContent.totalMatched} excerpts in 33 clusters`);
  });

  it("names only largest sections that lie in no other named one, with the excerpts they hold and the rest", async () => {
    const lines = [
      sectionGuide(data, 8).largestLine,
      (await getBoardContext({ boardId: data.boardId, maxChars: 24000 })).structuredContent.contextText.split("\n").find((line) => line.startsWith("Largest sections"))!,
    ];
    for (const [line, limit] of [[lines[0]!, 8], [lines[1]!, 10]] as const) {
      const named = [...line.matchAll(/(\d+:\d+) Theme [\d.]+ — (\d+)/g)].map(([, id, count]) => ({ id: id!, count: Number(count) }));
      expect(named).toHaveLength(limit);
      const sectionsOf = (id: string) => data.nodes.find((node) => node.id === id)!.sectionIds ?? [];
      for (const { id } of named) expect(named.some((other) => other.id !== id && sectionsOf(id).includes(other.id))).toBe(false);
      const covered = [...all.values()].filter((item) => item.sectionIds?.some((id) => named.some((section) => section.id === id))).length;
      expect(named.reduce((sum, { count }) => sum + count, 0)).toBe(covered);
      expect(line).toMatch(new RegExp(`^Largest sections \\(ID, name, excerpts\\): .*\\. Together they hold ${covered} of the board's ${all.size} excerpts\\.$`));
    }
    expect(sectionGuide(data, 8).outsideSections).toBe(outside.length);
    expect((await getBoardContext({ boardId: data.boardId, maxChars: 24000 })).structuredContent.contextText)
      .toContain(`${outside.length} excerpts outside sections; read them with outsideSections: true.`);
  });
});

describe("getBoardContext tables", () => {
  type PageRequest = Omit<GetBoardContextInput, "cursor">;
  type Shown = { evidenceId: string; sourceType: string; nodeId: string; row?: number };

  /** Pages through a request to the end; every page must fit limit and both budgets. */
  async function readPages(request: PageRequest) {
    const pages: Shown[][] = [];
    let cursor: string | undefined;
    let totalMatched = 0;
    do {
      const { text, structuredContent } = await getBoardContext({ ...request, cursor });
      const maxChars = request.maxChars ?? 12000;
      expect(text.length).toBeLessThanOrEqual(maxChars);
      expect(JSON.stringify(structuredContent).length).toBeLessThanOrEqual(maxChars);
      expect(structuredContent.evidence.length).toBeLessThanOrEqual(request.limit ?? 20);
      expect(structuredContent.evidence.length).toBeGreaterThan(0);
      pages.push(structuredContent.evidence);
      totalMatched = structuredContent.totalMatched;
      cursor = structuredContent.nextCursor;
    } while (cursor && pages.length < 500);
    expect(cursor).toBeUndefined();
    return { pages, totalMatched };
  }

  async function readAll(boardId: string, nodeIds?: string[]) {
    const { pages } = await readPages({ boardId, nodeIds, limit: 100, maxChars: 24000 });
    return { evidence: pages.flat(), pages: pages.length };
  }

  /**
   * Every page that continues a table starts its rows with the table's first row as
   * context; apart from that, every excerpt of the result sequence appears exactly once.
   */
  function expectContinuedTables(pages: Shown[][], totalMatched: number, firstRowId: string) {
    const sequence: string[] = [];
    pages.forEach((page, index) => {
      const rows = page.filter((item) => item.sourceType === "table_row");
      expect(new Set(page.map((item) => item.evidenceId)).size).toBe(page.length);
      if (index > 0 && rows.length) expect(rows[0]!.evidenceId).toBe(firstRowId);
      sequence.push(...page.map((item) => item.evidenceId).filter((id) => id !== firstRowId || index === 0));
    });
    expect(sequence).toHaveLength(totalMatched);
    expect(new Set(sequence).size).toBe(totalMatched);
  }

  it("renders consecutive rows of a table as one block and keeps one evidence entry per row", async () => {
    const data = tableBoard("TableBlock123", 4, 3);
    setBoard(data.boardId, data);
    const { text, structuredContent: output } = await getBoardContext({ boardId: data.boardId, nodeIds: ["1:1"] });
    expect(getBoardContextOutputSchema.safeParse(output).success).toBe(true);
    expect(output.evidence.map((item) => [item.sourceType, item.nodeId, item.renderNodeId, item.row, item.column])).toEqual(
      [0, 1, 2, 3].map((row) => ["table_row", "5:1", "5:1", row, undefined]));
    const [header, ...rows] = output.evidence;
    expect(text).toContain([
      "Table 5:1 · original · 4 rows × 3 columns · rows 0–3 shown · https://www.figma.com/board/TableBlock123?node-id=5%3A1",
      "Node name: Table 1",
      `[${header!.evidenceId}] row 0: Metric 1 | Metric 2 | Metric 3`,
      ...rows.map((item) => `[${item.evidenceId}] row ${item.row}: ${item.text}`),
    ].join("\n"));
    expect(rows[0]!.text).toBe("Participant 1 | 48 | 59");
    for (const item of output.evidence) {
      expect(text.split(item.text)).toHaveLength(2);
      expect(JSON.stringify(output).split(item.text)).toHaveLength(2);
    }
  });

  it("shows a match in a later row under the first row of its table", async () => {
    const data = evidenceBoard("TableTopic123", [{ ...textNode("5:1", ""), name: "Table 1", type: "TABLE", table: { cells:
      [["Item", "Owner"], ["Kickoff", "Ada"], ["Budget review", "Grace"], ["Retro", "Linus"]]
        .flatMap((cells, row) => cells.map((cellText, column) => ({ id: `T5:1;6:${row};7:${column}`, text: cellText }))),
    } }]);
    setBoard(data.boardId, data);
    const { text, structuredContent: output } = await getBoardContext({ boardId: data.boardId, topic: "budget" });
    expect(output.evidence.map((item) => [item.row, item.text])).toEqual([[0, "Item | Owner"], [2, "Budget review | Grace"]]);
    expect(text).toContain("Table 5:1 · original · 4 rows × 2 columns · rows 0, 2 shown · ");
    expect(text).toMatch(/\] row 0: Item \| Owner\n\[ev_[a-f0-9]+\] row 2: Budget review \| Grace/);
  });

  it("names the request for all rows when a page shows only some, unless the request names the table", async () => {
    const data = evidenceBoard("TableAllRows123", [{ ...textNode("5:1", ""), name: "Table 1", type: "TABLE", table: { cells:
      [["Item", "Owner"], ["Kickoff", "Ada"], ["Budget review", "Grace"], ["Retro", "Linus"]]
        .flatMap((cells, row) => cells.map((cellText, column) => ({ id: `T5:1;6:${row};7:${column}`, text: cellText }))),
    } }]);
    setBoard(data.boardId, data);
    const hint = 'request get_board_context with nodeIds: ["5:1"] for all rows';
    const topic = await getBoardContext({ boardId: data.boardId, topic: "budget" });
    expect(topic.text).toMatch(new RegExp(`Table 5:1 · original · 4 rows × 2 columns · rows 0, 2 shown · \\S+ · ${hint.replace(/[[\]]/g, "\\$&")}\n`));
    expect(topic.structuredContent.contextText).not.toContain(hint);
    expect(JSON.stringify(topic.structuredContent)).not.toContain(hint);
    for (const nodeIds of [["5:1"], ["T5:1;6:2;7:1"]]) {
      expect((await getBoardContext({ boardId: data.boardId, nodeIds, limit: 2 })).text).not.toContain("for all rows");
    }
    expect((await getBoardContext({ boardId: data.boardId })).text).not.toContain("for all rows");
    const section = tableBoard("TableSectionRows123", 24, 17);
    setBoard(section.boardId, section);
    expect((await getBoardContext({ boardId: section.boardId, nodeIds: ["1:1"], limit: 5 })).text).toContain(
      'rows 0–4 shown · https://www.figma.com/board/TableSectionRows123?node-id=5%3A1 · request get_board_context with nodeIds: ["5:1"] for all rows');
  });

  it("points a part of a long row to its table", async () => {
    const long = Array.from({ length: 8 }, (_, column) => `Column ${column} note `.repeat(12).trim());
    const data = evidenceBoard("TableParts123", [{ ...textNode("5:1", ""), name: "Table 1", type: "TABLE", table: { cells:
      [long.map((_, column) => `Heading ${column}`), long]
        .flatMap((cells, row) => cells.map((cellText, column) => ({ id: `T5:1;6:${row};7:${column}`, text: cellText }))),
    } }]);
    setBoard(data.boardId, data);
    const { text } = await getBoardContext({ boardId: data.boardId, limit: 2 });
    expect(text).toMatch(/\] row 1: Column 0 note .* \[Part 1 of 2 — request get_board_context with nodeIds: \["5:1"\] for the whole table\.\]/);
    // The cell ID returns both parts of its row, under the first row as context.
    const lookup = await getBoardContext({ boardId: data.boardId, nodeIds: ["T5:1;6:1;7:0"] });
    expect(lookup.structuredContent.evidence.map((item) => [item.row, item.chunkIndex])).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(lookup.structuredContent.totalMatched).toBe(2);
    expect(lookup.text).toContain("[Part 2 of 2.]");
  });

  it("reads a section with a 24 × 17 table in 24 row excerpts on one page instead of 408 cells on 7 pages", async () => {
    const rows = tableBoard("Table24x17", 24, 17);
    // Cell IDs outside the T<table>;<row>;<column> form keep the cell excerpts of 0.7.0.
    const cells = tableBoard("Cells24x17", 24, 17);
    cells.nodes[2]!.table!.cells.forEach((cell, index) => { cell.id = `cell:${index}`; });
    setBoard(rows.boardId, rows);
    setBoard(cells.boardId, cells);
    const before = await readAll(cells.boardId, ["1:1"]);
    const after = await readAll(rows.boardId, ["1:1"]);
    expect(before.evidence).toHaveLength(408);
    expect(before.evidence.every((item) => item.sourceType === "table_cell")).toBe(true);
    expect(before.pages).toBeGreaterThanOrEqual(7);
    expect(after.evidence).toHaveLength(24);
    expect(after.evidence.every((item) => item.sourceType === "table_row")).toBe(true);
    expect(after.pages).toBe(1);
  });

  it("starts each continuation of a table with its first row, read by table ID or unfocused", async () => {
    const data = tableBoard("TableContinued123", 24, 17);
    setBoard(data.boardId, data);
    const firstRowId = (await getBoardContext({ boardId: data.boardId, nodeIds: ["5:1"], limit: 1 })).structuredContent.evidence[0]!.evidenceId;
    for (const request of [{ nodeIds: ["5:1"] }, { maxChars: 2500 }]) {
      const { pages, totalMatched } = await readPages({ boardId: data.boardId, ...request });
      expect(pages.length).toBeGreaterThan(1);
      expect(totalMatched).toBe(24);
      expect(pages[1]!.map((item) => item.row).slice(0, 2)).toEqual([0, pages[0]!.at(-1)!.row! + 1]);
      expectContinuedTables(pages, totalMatched, firstRowId);
    }
    const { text, structuredContent } = await getBoardContext({ boardId: data.boardId, nodeIds: ["5:1"],
      cursor: (await getBoardContext({ boardId: data.boardId, nodeIds: ["5:1"] })).structuredContent.nextCursor });
    const continued = structuredContent.evidence.slice(1);
    expect(text).toContain(`rows 0, ${continued[0]!.row}–23 shown`);
    expect(structuredContent.contextText).toContain(`Page 2 of 2; no excerpts remaining.`);
    expect(structuredContent.truncation.remainingEvidence).toBe(0);
  });

  it("advances one row per page with limit 1 instead of repeating the first row", async () => {
    const data = tableBoard("TableLimit123", 6, 3);
    setBoard(data.boardId, data);
    const byTable = await readPages({ boardId: data.boardId, nodeIds: ["5:1"], limit: 1 });
    expect(byTable.pages.map((page) => page.map((item) => item.row))).toEqual([[0], [1], [2], [3], [4], [5]]);
    const byCell = await readPages({ boardId: data.boardId, nodeIds: ["T5:1;6:3;7:1"], limit: 1 });
    expect(byCell.pages.map((page) => page.map((item) => item.row))).toEqual([[3]]);
    const { structuredContent } = await getBoardContext({ boardId: data.boardId, nodeIds: ["T5:1;6:3;7:1"], limit: 2 });
    expect(structuredContent.evidence.map((item) => item.row)).toEqual([0, 3]);
  });

  it("shows a topic match under its first row when the first row was on the previous page", async () => {
    const data = evidenceBoard("TableTopicPages123", [{ ...textNode("5:1", ""), name: "Table 1", type: "TABLE", table: { cells:
      [["Item", "Owner"], ["Kickoff", "Ada"], ["Budget review", "Grace"], ["Budget approval", "Linus"]]
        .flatMap((cells, row) => cells.map((cellText, column) => ({ id: `T5:1;6:${row};7:${column}`, text: cellText }))),
    } }]);
    setBoard(data.boardId, data);
    const { pages, totalMatched } = await readPages({ boardId: data.boardId, topic: "budget", limit: 2 });
    expect(totalMatched).toBe(3);
    expect(pages.map((page) => page.map((item) => item.row))).toEqual([[0, 2], [0, 3]]);
    const second = await getBoardContext({ boardId: data.boardId, topic: "budget", limit: 2,
      cursor: (await getBoardContext({ boardId: data.boardId, topic: "budget", limit: 2 })).structuredContent.nextCursor });
    expect(second.text).toMatch(/\] row 0: Item \| Owner\n\[ev_[a-f0-9]+\] row 3: Budget approval \| Linus/);
  });
});
