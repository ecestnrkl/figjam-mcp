import { describe, expect, it } from "vitest";
import { setBoard } from "../src/lib/cache.js";
import { MAX_CONTEXT_RESPONSE_BYTES, retrieveEvidence, type Evidence } from "../src/lib/evidence.js";
import { redactBoard } from "../src/lib/redact.js";
import { getBoardContext, type BoardContextResult } from "../src/tools/getBoardContext.js";
import { getBoardContextOutputSchema, type GetBoardContextInput } from "../src/schemas/getBoardContext.js";
import {
  OVERVIEW_LONG_ID, OVERVIEW_METADATA_ID, OVERVIEW_MODEL_ID, OVERVIEW_NESTED_SECTION_ID,
  OVERVIEW_SECTION_IDS, OVERVIEW_TABLE_ID, overviewBoard,
} from "./fixtures/overviewBoard.js";
import type { BoardData } from "../src/types.js";
import { tableBoard } from "./fixtures/largeBoard.js";

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
const rows = (result: BoardContextResult) => result.structuredContent.overview!.text.split("\n")
  .filter((line) => /^\d+:\d+(?: \[[^\]]+\])*: /u.test(line));
const shortened = (text: string, limit: number) => {
  const normalized = normalize(text);
  return normalized.length <= limit ? normalized : normalized.slice(0, limit - 1) + "…";
};
function sourceLine(item: Evidence, limit: number, sequence: Evidence[]): string {
  const parts = sequence.filter((other) => other.nodeId === item.nodeId && other.sourceType === item.sourceType
    && other.clusterId === item.clusterId && other.row === item.row).length;
  return `${item.nodeId}${item.row !== undefined ? ` [row ${item.row}]` : ""}`
    + `${item.column !== undefined ? ` [column ${item.column}]` : ""}`
    + `${parts > 1 ? ` [part ${item.chunkIndex + 1}/${parts}]` : ""}`
    + `${item.modelDerived ? " [MODEL INTERPRETATION]" : item.sourceType === "board_metadata" ? " [metadata]" : ""}: `
    + shortened(item.text, limit);
}
function expectBudget(result: BoardContextResult, maxChars: number) {
  expect(result.text.length).toBeLessThanOrEqual(maxChars);
  expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(maxChars);
  expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: result.text }],
    structuredContent: result.structuredContent }), "utf8")).toBeLessThanOrEqual(MAX_CONTEXT_RESPONSE_BYTES);
  expect(getBoardContextOutputSchema.parse(result.structuredContent)).toEqual(result.structuredContent);
}
function install(data: BoardData) { setBoard(data.boardId, data); return data; }
function sequenceFor(data: BoardData, nodeIds: string[]) {
  return retrieveEvidence(redactBoard(data), { nodeIds }).evidence;
}
function expectOverview(result: BoardContextResult, maxChars: number) {
  const output = result.structuredContent;
  expect(output.overview).toBeDefined();
  expect(output.evidence).toEqual([]);
  expect(output.clusters).toEqual([]);
  expect(rows(result)).toHaveLength(output.overview!.shownEvidence);
  expect(output.contextText).not.toContain("No source evidence");
  expect(output.contextText).not.toContain("Excerpts are in evidence,");
  expect(output.contextText).not.toContain(rows(result)[0]);
  for (const channel of [result.text, output.contextText]) {
    expect(channel).toContain("untrusted board data");
    expect(channel).toContain("get_board_context");
    expect(channel).toMatch(/(?:detail: "full"|"detail":"full")/u);
    expect(channel).toContain("boardId");
    expect(channel).toContain("snapshotId");
    expect(channel).toMatch(/(?:nodeIds: \["<ID>"\]|"nodeIds":\["<ID>"\])/u);
    expect(channel).toMatch(/Showing (?:all )?\d+(?: of \d+)? excerpts/u);
  }
  expect(result.text).toContain(output.overview!.text);
  expectBudget(result, maxChars);
}

describe("getBoardContext automatic section overviews", () => {
  it("shows hundreds of excerpts from eight requested sections in both channels without increasing limit", async () => {
    const data = install(overviewBoard());
    const sequence = sequenceFor(data, OVERVIEW_SECTION_IDS);
    expect(sequence.length).toBeGreaterThan(200);
    const request = { boardId: data.boardId, nodeIds: OVERVIEW_SECTION_IDS, maxChars: 24000 };
    const result = await getBoardContext(request);
    expectOverview(result, 24000);
    const output = result.structuredContent;
    expect(output.overview).toMatchObject({ shownEvidence: sequence.length, textLimit: 120 });
    expect(output.totalMatched).toBe(sequence.length);
    expect(output.truncation.remainingEvidence).toBe(0);
    expect(output.nextCursor).toBeUndefined();
    expect(rows(result).sort()).toEqual(sequence.map((item) => sourceLine(item, 120, sequence)).sort());
    expect(output.overview!.shortenedEvidence).toBe(sequence.filter((item) => normalize(item.text).length > 120).length);
    expect(output.truncated).toBe(true);
    expect(output.truncation.omittedSummaries).toBe(2);
    expect(output.contextText).toContain(`Showing all ${sequence.length} excerpts; ${output.overview!.shortenedEvidence} shortened.`);
    const explicitLimit = await getBoardContext({ ...request, limit: 1 });
    expect(explicitLimit.structuredContent.overview).toEqual(output.overview);
    const full = await getBoardContext({ ...request, detail: "full" });
    expect(full.structuredContent.overview).toBeUndefined();
    expect(full.structuredContent.evidence.length).toBeLessThanOrEqual(20);
    expect(full.structuredContent.truncation.remainingEvidence).toBeGreaterThan(0);
    expect(full.structuredContent.nextCursor).toBeDefined();
  });

  it("groups inner sections separately by ID, normalizes whitespace, and preserves duplicate source excerpts", async () => {
    const data = install(overviewBoard("OverviewSources123"));
    const result = await getBoardContext({ boardId: data.boardId, nodeIds: OVERVIEW_SECTION_IDS, maxChars: 24000 });
    const text = result.structuredContent.overview!.text;
    for (const id of ["1:0", "1:1", OVERVIEW_NESTED_SECTION_ID]) expect(text).toContain(`## Shared theme (${id})`);
    expect(text).toContain("15:0: First line second line");
    expect(text).not.toContain("\t");
    expect(text).not.toContain("synthetic-credential-123");
    expect(text).toContain("[redacted]");
    expect(rows(result).filter((line) => line.startsWith(`${OVERVIEW_MODEL_ID} [MODEL INTERPRETATION]:`))).toHaveLength(2);
    expect(rows(result)).toContain(`${OVERVIEW_METADATA_ID} [metadata]: Review badge`);
    expect(rows(result).filter((line) => line.includes("The same proposal."))).toHaveLength(2);
    expect(rows(result).filter((line) => line.startsWith(`${OVERVIEW_TABLE_ID} [row `))).toHaveLength(7);
    expect(text).toContain(`${OVERVIEW_TABLE_ID} [row 0]: Measure | Value`);
    expect(text).toContain(`${OVERVIEW_TABLE_ID} [row 1]: Repeated row | Same value`);
    expect(text).toContain(`${OVERVIEW_TABLE_ID} [row 2]: Repeated row | Same value`);
    expect(text).toContain(`${OVERVIEW_LONG_ID} [part 1/3]:`);
    expect(text).not.toContain("https://www.figma.com/");
    // Each group's content follows its existing single-container retrieval order.
    const groups = text.split(/(?=^## )/mu).filter((group) => group.startsWith("## "));
    for (const group of groups) {
      const sectionId = /\((\d+:\d+)\)/u.exec(group.split("\n")[0]!)?.[1];
      expect(sectionId).toBeDefined();
      const expected = sequenceFor(data, [sectionId!]).filter((item) => item.sectionIds?.at(-1) === sectionId);
      expect(group.split("\n").filter((line) => /^\d+:\d+(?: \[[^\]]+\])*: /u.test(line)))
        .toEqual(expected.map((item) => sourceLine(item, 120, expected)));
    }
  });

  it("keeps complete source text and Figma links reachable with the same snapshot and table or source ID", async () => {
    const data = install(overviewBoard("OverviewReadback123"));
    const overview = await getBoardContext({ boardId: data.boardId, nodeIds: OVERVIEW_SECTION_IDS });
    for (const nodeId of [OVERVIEW_LONG_ID, OVERVIEW_TABLE_ID, OVERVIEW_MODEL_ID, OVERVIEW_METADATA_ID]) {
      const result = await getBoardContext({ boardId: data.boardId, snapshotId: overview.structuredContent.snapshotId,
        nodeIds: [nodeId], detail: "full", maxChars: 24000 });
      expect(result.structuredContent.overview).toBeUndefined();
      const expected = sequenceFor(data, [nodeId]);
      expect(result.structuredContent.evidence.map((item) => item.text)).toEqual(expected.map((item) => item.text));
      for (const item of result.structuredContent.evidence) {
        expect(item.url).toBe(`https://www.figma.com/board/${data.boardId}?node-id=${encodeURIComponent(nodeId)}`);
        expect(item).not.toHaveProperty("snapshotId");
      }
      expect(result.structuredContent.snapshotId).toBe(data.snapshotId);
    }
  });

  it("keeps row positions and interpretation markers on every part of long sources", async () => {
    const data = overviewBoard("OverviewSourceParts123");
    const table = data.nodes.find((node) => node.id === OVERVIEW_TABLE_ID)!;
    table.table!.cells.filter((cell) => cell.row === 1).forEach((cell) => { cell.text = "Original table detail. ".repeat(80); });
    data.clusters.filter((cluster) => cluster.id.startsWith("image")).forEach((cluster) => {
      cluster.summary = "Synthetic model interpretation. ".repeat(90);
    });
    install(data);
    const nodeIds = ["1:3", "1:4"];
    const sequence = sequenceFor(data, nodeIds);
    const result = await getBoardContext({ boardId: data.boardId, nodeIds, maxChars: 24000 });
    expectOverview(result, 24000);
    expect(rows(result).sort()).toEqual(sequence.map((item) => sourceLine(item, 120, sequence)).sort());
    const tableParts = rows(result).filter((line) => line.startsWith(`${OVERVIEW_TABLE_ID} [row 1]`));
    expect(tableParts.length).toBeGreaterThan(1);
    expect(tableParts.every((line) => /\[row 1\] \[part \d+\/\d+\]:/u.test(line))).toBe(true);
    const modelParts = rows(result).filter((line) => line.startsWith(OVERVIEW_MODEL_ID));
    expect(modelParts.length).toBeGreaterThan(2);
    expect(modelParts.every((line) => /\[part \d+\/\d+\] \[MODEL INTERPRETATION\]:/u.test(line))).toBe(true);
  });

  it("counts consumed full excerpts without counting a repeated table header again", async () => {
    const data = install(tableBoard("FullConsumedCount123", 24, 3));
    const request = { boardId: data.boardId, nodeIds: ["5:1"], detail: "full" as const, limit: 5 };
    const first = await getBoardContext(request);
    const second = await getBoardContext({ ...request, cursor: first.structuredContent.nextCursor });
    expect(second.structuredContent.evidence.map((item) => item.row)).toEqual([0, 5, 6, 7, 8]);
    expect(second.structuredContent.truncation.remainingEvidence).toBe(15);
    for (const channel of [second.text, second.structuredContent.contextText]) {
      expect(channel).toContain("Showing 4 of 24 excerpts on this page; 15 remaining.");
    }
  });

  it("uses the evidence's innermost section path even when the section node has no recorded ancestry", async () => {
    const data = overviewBoard("SectionPath123");
    const child = data.nodes.find((node) => node.id === OVERVIEW_NESTED_SECTION_ID)!;
    delete child.parentId;
    delete child.sectionIds;
    install(data);
    const result = await getBoardContext({ boardId: data.boardId, nodeIds: ["1:0"], maxChars: 24000 });
    const text = result.structuredContent.overview!.text;
    const inner = text.slice(text.indexOf(`## Shared theme (${OVERVIEW_NESTED_SECTION_ID})`));
    expect(inner).toContain("10:24: Idea 0-24: less waiting.");
    expect(inner).toContain("10:27: Idea 0-27: less waiting.");
    expect(text.split("10:24:")).toHaveLength(2);
  });

  it("still reads an eligible container when full evidence cannot fit even one excerpt", async () => {
    const data = overviewBoard("DeepSection123");
    const page = data.nodes[0]!;
    const sectionIds = Array.from({ length: 16 }, (_, index) => `80:${index}`);
    const sections = sectionIds.map((id, index) => ({ ...page, id, type: "SECTION", pageId: page.id,
      name: `Nested section ${index} ` + "very long source heading ".repeat(20),
      sectionIds: sectionIds.slice(0, index + 1) }));
    const sources = data.nodes.filter((node) => node.type === "STICKY").map((node) => ({ ...node,
      parentId: sectionIds.at(-1), sectionIds }));
    data.nodes = [page, ...sections, ...sources];
    data.clusters.forEach((cluster) => { cluster.label = "Long cluster name ".repeat(30); });
    install(data);
    await expect(getBoardContext({ boardId: data.boardId, nodeIds: [sectionIds[0]!], detail: "full", maxChars: 2000 }))
      .rejects.toThrow(/budget cannot fit/u);
    const result = await getBoardContext({ boardId: data.boardId, nodeIds: [sectionIds[0]!], maxChars: 2000 });
    expectOverview(result, 2000);
    expect(result.structuredContent.overview!.shownEvidence).toBeGreaterThan(0);
  });

  it.each(["0:1", "1:0", "3:0", "3:1"])("switches a large readable container %s only when the full page has unread excerpts", async (nodeId) => {
    const data = install(overviewBoard(`AutoContainer${nodeId.replace(":", "")}`));
    const result = await getBoardContext({ boardId: data.boardId, nodeIds: [nodeId], maxChars: 24000 });
    expectOverview(result, 24000);
    expect(result.structuredContent.overview!.shownEvidence).toBe(sequenceFor(data, [nodeId]).length);
    const full = await getBoardContext({ boardId: data.boardId, nodeIds: [nodeId], detail: "full", maxChars: 24000 });
    expect(full.structuredContent.truncation.remainingEvidence).toBeGreaterThan(0);
  });

  it("uses full mode for non-container selectors, duplicate IDs, small containers and non-node queries", async () => {
    const data = install(overviewBoard("NoAuto123"));
    const requests: GetBoardContextInput[] = [
      { boardId: data.boardId }, { boardId: data.boardId, topic: "Idea" },
      { boardId: data.boardId, outsideSections: true },
      { boardId: data.boardId, nodeIds: ["10:0"] }, { boardId: data.boardId, nodeIds: ["10:0", "10:0"], limit: 1 },
      { boardId: data.boardId, nodeIds: [OVERVIEW_TABLE_ID], limit: 1 },
      { boardId: data.boardId, nodeIds: [`T${OVERVIEW_TABLE_ID};41:2;42:1`], limit: 1 },
      { boardId: data.boardId, nodeIds: [OVERVIEW_NESTED_SECTION_ID] },
      { boardId: data.boardId, nodeIds: ["1:0"], limit: 100, maxChars: 24000 },
    ];
    for (const request of requests) expect((await getBoardContext(request)).structuredContent.overview).toBeUndefined();
    // A long leaf is internally chunked/truncated; that alone never triggers overview.
    const leaf = await getBoardContext({ boardId: data.boardId, nodeIds: [OVERVIEW_LONG_ID], limit: 1 });
    expect(leaf.structuredContent.truncated).toBe(true);
    expect(leaf.structuredContent.truncation.remainingEvidence).toBeGreaterThan(0);
    expect(leaf.structuredContent.overview).toBeUndefined();
    const small = await getBoardContext({ boardId: data.boardId, nodeIds: [OVERVIEW_NESTED_SECTION_ID], limit: 100 });
    expect(small.structuredContent.truncation.remainingEvidence).toBe(0);
  });

  it("does not use omitted arrows as an overview trigger for a fully read container", async () => {
    const data = overviewBoard("ArrowsNoAuto123", { notesPerSection: 1, noteText: () => "Short note" });
    data.connectorEdges = Array.from({ length: 150 }, (_, index) => ({ connectorId: `90:${index}`,
      fromNodeId: "10:0", toNodeId: "11:0", direction: "forward", label: `Arrow ${index}` }));
    install(data);
    const result = await getBoardContext({ boardId: data.boardId, nodeIds: ["0:1"], limit: 100, maxChars: 24000 });
    expect(result.structuredContent.truncation.remainingEvidence).toBe(0);
    expect(result.structuredContent.truncation.omittedConnections).toBeGreaterThan(0);
    expect(result.structuredContent.truncated).toBe(true);
    expect(result.structuredContent.overview).toBeUndefined();
  });

  it("uses the largest common fitting prefix, including ellipses and JSON escaping", async () => {
    const data = install(overviewBoard("PrefixLimit123", { notesPerSection: 26,
      noteText: (section, index) => `Unique ${section}-${index}: ` + '"Escaped words" \\ repeated details. '.repeat(8) }));
    const sequence = sequenceFor(data, OVERVIEW_SECTION_IDS);
    const result = await getBoardContext({ boardId: data.boardId, nodeIds: OVERVIEW_SECTION_IDS, maxChars: 24000 });
    expectOverview(result, 24000);
    const overview = result.structuredContent.overview!;
    expect(overview.shownEvidence).toBe(sequence.length);
    expect(overview.textLimit).toBeGreaterThanOrEqual(50);
    expect(overview.textLimit).toBeLessThan(120);
    expect(rows(result).sort()).toEqual(sequence.map((item) => sourceLine(item, overview.textLimit, sequence)).sort());
    expect(overview.shortenedEvidence).toBe(sequence.filter((item) => normalize(item.text).length > overview.textLimit).length);
    const extendedText = overview.text.split("\n").map((line) => {
      const source = sequence.find((item) => sourceLine(item, overview.textLimit, sequence) === line);
      return source ? sourceLine(source, overview.textLimit + 1, sequence) : line;
    }).join("\n");
    const extended = { ...result.structuredContent, overview: { ...overview, textLimit: overview.textLimit + 1, text: extendedText } };
    const readable = result.text.replace(overview.text, extendedText);
    expect(readable.length > 24000 || JSON.stringify(extended).length > 24000
      || Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: readable }], structuredContent: extended })) > MAX_CONTEXT_RESPONSE_BYTES).toBe(true);
  });

  it("lets overview lines use the budget before arrows and counts every omitted arrow", async () => {
    const data = overviewBoard("OverviewArrowPriority123", { notesPerSection: 26,
      noteText: (section, index) => `Idea ${section}-${index}: ` + "Readable original details. ".repeat(5) });
    install(data);
    const request = { boardId: data.boardId, nodeIds: OVERVIEW_SECTION_IDS, maxChars: 24000 };
    const plain = await getBoardContext(request);
    data.connectorEdges = Array.from({ length: 150 }, (_, index) => ({ connectorId: `90:${index}`,
      fromNodeId: `10:${index % 26}`, toNodeId: `11:${index % 26}`, direction: "forward", label: "Synthetic relationship" }));
    // A new board object keeps the evidence/redaction memoization faithful to immutable snapshots.
    install({ ...data, connectorEdges: data.connectorEdges });
    const connected = await getBoardContext(request);
    expectOverview(connected, 24000);
    expect(connected.structuredContent.overview).toEqual(plain.structuredContent.overview);
    expect(connected.structuredContent.connections.length + connected.structuredContent.truncation.omittedConnections).toBe(150);
    expect(connected.structuredContent.truncation.omittedTextConnections).toBe(connected.structuredContent.truncation.omittedConnections);
  });

  it("reduces the prefix when UTF-8 MCP bytes bind before either channel's character budget", async () => {
    const data = install(overviewBoard("OverviewUtf8Cap123", { notesPerSection: 22, noteText: () => "漢".repeat(400) }));
    const sequence = sequenceFor(data, OVERVIEW_SECTION_IDS);
    const result = await getBoardContext({ boardId: data.boardId, nodeIds: OVERVIEW_SECTION_IDS, maxChars: 24000 });
    expectOverview(result, 24000);
    const overview = result.structuredContent.overview!;
    expect(overview.shownEvidence).toBe(sequence.length);
    expect(overview.textLimit).toBeLessThan(120);
    expect(overview.textLimit).toBeGreaterThan(50);
    const extendedText = overview.text.split("\n").map((line) => {
      const source = sequence.find((item) => sourceLine(item, overview.textLimit, sequence) === line);
      return source ? sourceLine(source, overview.textLimit + 1, sequence) : line;
    }).join("\n");
    const extended = { ...result.structuredContent, overview: { ...overview, textLimit: overview.textLimit + 1, text: extendedText } };
    const readable = result.text.replace(overview.text, extendedText);
    expect(readable.length).toBeLessThanOrEqual(24000);
    expect(JSON.stringify(extended).length).toBeLessThanOrEqual(24000);
    expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: readable }], structuredContent: extended })))
      .toBeGreaterThan(MAX_CONTEXT_RESPONSE_BYTES);
  });

  it("paginates at 50 characters without losing repeated rows, chunks, overlapping selections or interpretations", async () => {
    const data = install(overviewBoard("OverviewPaging123", { notesPerSection: 36,
      noteText: (section, index) => `Original ${section}-${index}. ` + "The rest of this long synthetic source remains available for full reading. ".repeat(5) }));
    const nodeIds = ["1:0", OVERVIEW_NESTED_SECTION_ID, ...OVERVIEW_SECTION_IDS.slice(1)];
    const sequence = sequenceFor(data, nodeIds);
    let cursor: string | undefined;
    let consumed = 0;
    let pages = 0;
    const seen: string[] = [];
    do {
      const result = await getBoardContext({ boardId: data.boardId, nodeIds, maxChars: 2000, limit: 1, cursor });
      expectOverview(result, 2000);
      const output = result.structuredContent;
      const overview = output.overview!;
      expect(overview.textLimit).toBe(50);
      expect(overview.shownEvidence).toBeGreaterThan(0);
      const pageSequence = sequence.slice(consumed, consumed + overview.shownEvidence);
      expect(rows(result).sort()).toEqual(pageSequence.map((item) => sourceLine(item, 50, sequence)).sort());
      seen.push(...rows(result));
      consumed += overview.shownEvidence;
      expect(output.truncation.remainingEvidence).toBe(sequence.length - consumed);
      expect(overview.shortenedEvidence).toBe(pageSequence.filter((item) => normalize(item.text).length > 50).length);
      expect(output.totalMatched).toBe(sequence.length);
      expect(Boolean(output.nextCursor)).toBe(consumed < sequence.length);
      cursor = output.nextCursor;
      pages++;
      expect(pages).toBeLessThan(100);
      if (!cursor) {
        expect(overview.shortenedEvidence).toBeGreaterThan(0);
        expect(output.truncated).toBe(true);
      }
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(consumed).toBe(sequence.length);
    expect(seen.sort()).toEqual(sequence.map((item) => sourceLine(item, 50, sequence)).sort());
  });

  it("fills a 50-character overview page to the largest count that actually serializes within budget", async () => {
    const data = install(overviewBoard("OverviewLargestPage123", { notesPerSection: 90,
      noteText: (section, index) => `Source ${section}-${index}: ` + "Original source detail. ".repeat(12) }));
    const nodeIds = ["3:0"];
    const sequence = sequenceFor(data, nodeIds);
    const result = await getBoardContext({ boardId: data.boardId, nodeIds, maxChars: 2000 });
    expectOverview(result, 2000);
    const output = result.structuredContent;
    const overview = output.overview!;
    expect(overview.textLimit).toBe(50);
    expect(overview.shownEvidence).toBeLessThan(sequence.length);
    expect(overview.shortenedEvidence).toBe(overview.shownEvidence);
    expect(output.nextCursor).toBeDefined();
    const nextCount = overview.shownEvidence + 1;
    const nextRemaining = sequence.length - nextCount;
    const nextText = `${overview.text}\n${sourceLine(sequence[overview.shownEvidence]!, 50, sequence)}`;
    const nextOrientation = output.contextText.replace(
      /Showing \d+ of \d+ excerpts on this page; \d+ remaining; \d+ shortened\./u,
      `Showing ${nextCount} of ${sequence.length} excerpts on this page; ${nextRemaining} remaining; ${nextCount} shortened.`,
    );
    expect(nextOrientation).not.toBe(output.contextText);
    // Only the offset's digit count affects serialization; the checksum has a fixed width.
    const cursorFields = output.nextCursor!.split(".");
    expect(cursorFields.slice(0, 2)).toEqual(["v2", "o"]);
    cursorFields[3] = String(nextCount);
    const extended = { ...output, contextText: nextOrientation, nextCursor: cursorFields.join("."),
      overview: { ...overview, text: nextText, shownEvidence: nextCount, shortenedEvidence: nextCount },
      truncation: { ...output.truncation, remainingEvidence: nextRemaining } };
    const readable = result.text.replace(output.contextText, nextOrientation).replace(overview.text, nextText);
    expect(readable.length > 2000 || JSON.stringify(extended).length > 2000
      || Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: readable }], structuredContent: extended }))
      > MAX_CONTEXT_RESPONSE_BYTES).toBe(true);
  });

  it("retains requested-ID turn order before grouping and binds it to pagination", async () => {
    const data = install(overviewBoard("OverviewOrder123", { notesPerSection: 28,
      noteText: (section, index) => `Order ${section}-${index}: ` + "Keep each source separate. ".repeat(8) }));
    for (const nodeIds of [["1:1", "1:0"], ["1:0", "1:1"]]) {
      const result = await getBoardContext({ boardId: data.boardId, nodeIds, maxChars: 2000 });
      const expected = sequenceFor(data, nodeIds);
      const selected = expected.slice(0, result.structuredContent.overview!.shownEvidence);
      expect(rows(result).sort()).toEqual(selected.map((item) => sourceLine(item, 50, expected)).sort());
      expect(rows(result)[0]!.startsWith(nodeIds[0] === "1:0" ? "10:" : "11:")).toBe(true);
      await expect(getBoardContext({ boardId: data.boardId, nodeIds: [...nodeIds].reverse(), maxChars: 2000,
        cursor: result.structuredContent.nextCursor })).rejects.toThrow(/Cursor does not match/u);
    }
  });

  it.each([2000, 12000, 24000])("budgets actual serialized channels and UTF-8 with Unicode, long headings and credentials at %i", async (maxChars) => {
    const data = install(overviewBoard(`OverviewBudget${maxChars}`, { notesPerSection: 36,
      sectionName: (section) => `Section ${section} \"quoted\" \\ 漢字🙂\n` + "Long heading ".repeat(200),
      noteText: (section, index) => index % 4 === 0 ? `API key: fake-secret-${section}-${index}\nVisible follow-up.`
        : `Quoted \"${section}-${index}\" \\ tabs\tand newlines\n漢字🙂 ` + "🙂漢字\\\" ".repeat(40) }));
    const result = await getBoardContext({ boardId: data.boardId, nodeIds: OVERVIEW_SECTION_IDS, maxChars });
    expectOverview(result, maxChars);
    expect(result.structuredContent.overview!.shownEvidence).toBeGreaterThan(0);
    expect(result.text).not.toContain("fake-secret-");
    expect(JSON.stringify(result.structuredContent)).not.toContain("fake-secret-");
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(result.structuredContent.overview!.text).not.toContain("\t");
  });

  it("preserves factual unknown and empty-ID notices in a populated overview within the budget", async () => {
    const data = install(overviewBoard("OverviewMissing123"));
    const result = await getBoardContext({ boardId: data.boardId, nodeIds: ["0:1", "71:0", "999:999"], maxChars: 2000 });
    expectOverview(result, 2000);
    expect(result.structuredContent.unknownNodeIds).toEqual(["999:999"]);
    for (const channel of [result.text, result.structuredContent.contextText]) {
      expect(channel).toContain("Not in this snapshot: 999:999.");
      expect(channel).toMatch(/(?:no|without) text/u);
      expect(channel).toContain("71:0");
    }
    const empty = await getBoardContext({ boardId: data.boardId, nodeIds: ["71:0"] });
    expect(empty.structuredContent.overview).toBeUndefined();
    expect(empty.structuredContent.totalMatched).toBe(0);
    await expect(getBoardContext({ boardId: data.boardId, nodeIds: ["999:999", "998:998"] })).rejects.toThrow(/No nodes with IDs/u);
  });

  it("omits only standard full-evidence fields and preserves internal evidence and model provenance", async () => {
    const data = install(overviewBoard("SlimEvidence123"));
    const result = await getBoardContext({ boardId: data.boardId, nodeIds: [OVERVIEW_LONG_ID, OVERVIEW_MODEL_ID, "10:0"],
      detail: "full", limit: 100, maxChars: 24000 });
    expect(result.structuredContent.overview).toBeUndefined();
    expectBudget(result, 24000);
    for (const item of result.structuredContent.evidence) {
      expect(item).not.toHaveProperty("snapshotId");
      for (const required of ["evidenceId", "nodeId", "text", "sourceType", "url"]) expect(item).toHaveProperty(required);
      const source = sequenceFor(data, [item.nodeId]).find((candidate) => candidate.evidenceId === item.evidenceId)!;
      expect(item.chunkIndex).toBe(source.chunkIndex === 0 ? undefined : source.chunkIndex);
      expect(item.truncated).toBe(source.truncated || undefined);
      expect(item.modelDerived).toBe(source.modelDerived || undefined);
      expect(source).toHaveProperty("snapshotId", data.snapshotId);
      expect(source.chunkIndex).toBeTypeOf("number");
      expect(source.modelDerived).toBeTypeOf("boolean");
      expect(source.truncated).toBeTypeOf("boolean");
    }
    expect(result.structuredContent.evidence.filter((item) => item.modelDerived === true)).toHaveLength(2);
    const zero = result.structuredContent.evidence.find((item) => item.nodeId === "10:0")!;
    expect(getBoardContextOutputSchema.parse(result.structuredContent).evidence.find((item) => item.evidenceId === zero.evidenceId))
      .toEqual(zero);
  });
});
