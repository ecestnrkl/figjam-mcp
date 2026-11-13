import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { setBoard } from "../src/lib/cache.js";
import * as evidence from "../src/lib/evidence.js";
import { getBoardContextInputSchema, getBoardContextOutputSchema, evidenceSchema } from "../src/schemas/getBoardContext.js";
import { getBoardContext } from "../src/tools/getBoardContext.js";
import { largeBoard } from "./fixtures/largeBoard.js";
import { evidenceBoard, textNode } from "./fixtures/retrieval.js";

describe("context representation contract", () => {
  it("defaults detail to auto, validates the two modes and preserves the 24,000-character maximum", () => {
    expect(getBoardContextInputSchema.parse({ boardId: "Schema123" }).detail).toBe("auto");
    expect(getBoardContextInputSchema.parse({ boardId: "Schema123", detail: "full", limit: 100 }).detail).toBe("full");
    expect(getBoardContextInputSchema.safeParse({ boardId: "Schema123", detail: "overview" }).success).toBe(false);
    expect(getBoardContextInputSchema.safeParse({ boardId: "Schema123", maxChars: 24001 }).success).toBe(false);
  });

  it("omits only inherited snapshot and default evidence fields without weakening internal evidence", async () => {
    const data = evidenceBoard("SlimContext123", [textNode("3:1", "A short source note.")]);
    setBoard(data.boardId, data);
    const { structuredContent: output } = await getBoardContext({ boardId: data.boardId, detail: "full" });
    const item = output.evidence[0]!;
    expect(item).toMatchObject({ evidenceId: expect.any(String), nodeId: "3:1", text: "A short source note.",
      sourceType: "board_text", url: expect.stringContaining("node-id=3%3A1") });
    expect(item).not.toHaveProperty("snapshotId");
    expect(item).not.toHaveProperty("chunkIndex");
    expect(item).not.toHaveProperty("modelDerived");
    expect(item).not.toHaveProperty("truncated");
    expect(getBoardContextOutputSchema.parse(output).evidence[0]).toEqual(item);
    const internal = evidence.retrieveEvidence(data).evidence[0]!;
    expect(internal).toMatchObject({ snapshotId: output.snapshotId, chunkIndex: 0, modelDerived: false, truncated: false });
    for (const required of ["evidenceId", "nodeId", "text", "sourceType", "url"]) {
      const incomplete = { ...item } as Record<string, unknown>;
      delete incomplete[required];
      expect(evidenceSchema.safeParse(incomplete).success).toBe(false);
    }
  });

  it("retains nondefault chunk, truncation and model provenance fields", async () => {
    const data = evidenceBoard("SlimParts123", [textNode("3:1", "Synthetic paragraph. ".repeat(400))]);
    data.clusters[0]!.summarySource = "vision_llm";
    data.clusters[0]!.summary = "Synthetic model interpretation.";
    setBoard(data.boardId, data);
    const { structuredContent: output } = await getBoardContext({ boardId: data.boardId, nodeIds: ["3:1"], detail: "full", limit: 100, maxChars: 24000 });
    expect(output.evidence.some((item) => (item.chunkIndex ?? 0) > 0)).toBe(true);
    expect(output.evidence.some((item) => item.truncated === true)).toBe(true);
    const interpretation = await getBoardContext({ boardId: data.boardId, detail: "full", limit: 100, maxChars: 24000 });
    expect(interpretation.structuredContent.evidence.find((item) => item.modelDerived)?.modelDerived).toBe(true);
    expect(output.evidence.every((item) => item.snapshotId === undefined)).toBe(true);
  });

  it("validates compact overview counts without injecting evidence defaults", async () => {
    const data = evidenceBoard("OverviewSchema123");
    setBoard(data.boardId, data);
    const result = (await getBoardContext({ boardId: data.boardId, detail: "full" })).structuredContent;
    const output = { ...result, evidence: [], clusters: [], overview: { text: "1:1: A source", shownEvidence: 1, shortenedEvidence: 0, textLimit: 120 } };
    expect(getBoardContextOutputSchema.parse(output).overview).toEqual(output.overview);
    for (const invalid of [{ textLimit: 49 }, { textLimit: 121 }, { shownEvidence: -1 }, { shortenedEvidence: 0.5 }]) {
      expect(getBoardContextOutputSchema.safeParse({ ...output, overview: { ...output.overview, ...invalid } }).success).toBe(false);
    }
  });
});

/** Both pages have nested sections and a table and notes outside sections. */
function twoPageBoard() {
  const first = largeBoard("PagedSections123", 32, 13, 5, { subsections: 2, outsideClusters: 2 });
  const second = structuredClone(first);
  const secondId = (id: string) => id.replace(/^(\d+):/, (_, prefix: string) => `${prefix}0:`);
  for (const node of second.nodes) {
    node.id = secondId(node.id);
    if (node.pageId) node.pageId = secondId(node.pageId);
    if (node.parentId) node.parentId = secondId(node.parentId);
    if (node.sectionIds) node.sectionIds = node.sectionIds.map(secondId);
    if (node.renderNodeId) node.renderNodeId = secondId(node.renderNodeId);
    for (const cell of node.table?.cells ?? []) cell.id = cell.id.replace(/^T8:0;/, "T80:0;");
  }
  second.nodes[0]!.name = "Follow-up workshop";
  for (const cluster of second.clusters) {
    cluster.id = `followup_${cluster.id}`;
    cluster.nodeIds = cluster.nodeIds.map(secondId);
    cluster.confirmedNodeIds = cluster.confirmedNodeIds?.map(secondId);
  }
  first.nodes.push(...second.nodes);
  first.clusters.push(...second.clusters);
  return first;
}

describe("whole-page reads", () => {
  it.each([
    ["full", 12000, "1b2b77902186ecfef21af36c604b00bf86a01aa4f8bc1c4f7dbde615d9cf291e"],
    ["full", 24000, "d47964105deee745fb8ed746788ecf3ac436d8a3af5e6758b63f5372557b93d5"],
    ["auto", 12000, "1921fc8765bfe8fd8367cc4b7c4fca0c761e942338e690b280cb7c792e1510aa"],
    ["auto", 24000, "f3c3e342fe7cec8801f7296104ce23539de9d82d239d9e059e2d153ffba77cc3"],
  ] as const)("preserves the response bytes through the last cursor in %s with maxChars %i", async (detail, maxChars, expected) => {
    const data = twoPageBoard();
    setBoard(data.boardId, data);
    // Captured on c03489b. Hash one JSON line per response, in cursor order, for both pages.
    const hash = createHash("sha256");
    for (const pageId of ["0:1", "00:1"]) {
      const request = { boardId: data.boardId, snapshotId: data.snapshotId, nodeIds: [pageId], detail, maxChars };
      let cursor: string | undefined;
      let pages = 0;
      do {
        const result = await getBoardContext({ ...request, cursor });
        hash.update(JSON.stringify(result)).update("\n");
        cursor = result.structuredContent.nextCursor;
        expect(++pages).toBeLessThan(100);
      } while (cursor);
      expect(pages).toBeGreaterThan(1);
    }
    expect(hash.digest("hex")).toBe(expected);
  });

  it("reuses the page retrieval and reads no sections individually through the next cursor", async () => {
    const data = largeBoard("SectionRetrieval123", 8, 12, 4, { subsections: 2, outsideClusters: 2 });
    setBoard(data.boardId, data);
    const sectionIds = new Set(data.nodes.filter((node) => node.type === "SECTION").map((node) => node.id));
    const retrieve = vi.spyOn(evidence, "retrieveEvidence");
    try {
      const request = { boardId: data.boardId, nodeIds: ["0:1"], maxChars: 4000 };
      const result = await getBoardContext(request);
      const cursor = result.structuredContent.nextCursor;
      expect(cursor).toMatch(/^v2\.o\./);
      await getBoardContext({ ...request, cursor });
      const scopes = retrieve.mock.calls.flatMap(([, query]) => query?.nodeIds ?? []);
      expect(scopes.filter((id) => id === "0:1" || sectionIds.has(id))).toEqual(["0:1"]);
    } finally {
      retrieve.mockRestore();
    }
  });
});

describe("versioned context cursors", () => {
  it("binds new full cursors to requested detail and rejects a changed representation", async () => {
    const data = largeBoard("ModeCursor123", 8, 12, 2);
    setBoard(data.boardId, data);
    const request = { boardId: data.boardId, nodeIds: ["0:1"], detail: "full" as const, limit: 5 };
    const first = (await getBoardContext(request)).structuredContent;
    expect(first.nextCursor).toMatch(/^v2\.f\.2\.5\.cccccccccccc\.[a-f0-9]{12}$/);
    expect(first.nextCursor!.length).toBeLessThanOrEqual(48);
    const second = (await getBoardContext({ ...request, cursor: first.nextCursor })).structuredContent;
    expect(second.overview).toBeUndefined();
    expect(second.evidence.length).toBeGreaterThan(0);
    await expect(getBoardContext({ ...request, detail: "auto", cursor: first.nextCursor })).rejects.toThrow(/detail/);
    await expect(getBoardContext({ ...request, cursor: first.nextCursor!.replace("v2.f.", "v2.o.") })).rejects.toThrow(/Cursor does not match/);
  });

  it("keeps an auto overview cursor in overview through the last page and binds requested detail", async () => {
    const data = largeBoard("OverviewCursor123", 8, 12, 2);
    setBoard(data.boardId, data);
    const request = { boardId: data.boardId, nodeIds: ["0:1"], limit: 1, maxChars: 2000 };
    const first = (await getBoardContext(request)).structuredContent;
    expect(first.overview).toBeDefined();
    expect(first.nextCursor).toMatch(/^v2\.o\./);
    await expect(getBoardContext({ ...request, detail: "full", cursor: first.nextCursor })).rejects.toThrow(/detail/);
    await expect(getBoardContext({ ...request, cursor: first.nextCursor!.replace("v2.o.", "v2.f.") })).rejects.toThrow(/Cursor does not match/);
    let output = first;
    let shown = first.overview!.shownEvidence;
    let pages = 1;
    while (output.nextCursor && pages < 100) {
      output = (await getBoardContext({ ...request, cursor: output.nextCursor })).structuredContent;
      expect(output.overview?.textLimit).toBe(50);
      expect(output.evidence).toEqual([]);
      shown += output.overview!.shownEvidence;
      pages++;
    }
    expect(output.overview).toBeDefined();
    expect(output.nextCursor).toBeUndefined();
    expect(output.truncation.remainingEvidence).toBe(0);
    expect(shown).toBe(first.totalMatched);
  });

  it("continues an actual pre-detail short cursor in full mode for omitted, auto or full detail", async () => {
    const data = largeBoard("LegacyScope123", 8, 12, 2);
    setBoard(data.boardId, data);
    // Recorded from the unmodified 0d72e3f tool for this exact synthetic request and fixture.
    const legacy = "2.5.cccccccccccc.d638e9ba3913";
    const request = { boardId: data.boardId, nodeIds: ["0:1"], limit: 5 };
    expect((await getBoardContext(request)).structuredContent.overview).toBeDefined();
    const expected = ["ev_b3f5932d4a0c252caeb55f80aa1b5ba1", "ev_ea2e9193541c23491c761b1617e8bd2c",
      "ev_2cfad50a6358425b48394d7310ad10dd", "ev_b34307f4af380a9fb86b8053c9dbe02a", "ev_bbf4f932191918c5c280f2a67f66aefc"];
    for (const detail of [undefined, "auto", "full"] as const) {
      const output = (await getBoardContext({ ...request, detail, cursor: legacy })).structuredContent;
      expect(output.overview).toBeUndefined();
      expect(output.evidence.map((item) => item.evidenceId)).toEqual(expected);
      expect(output.nextCursor).toMatch(/^v2\.f\./);
      const next = (await getBoardContext({ ...request, detail, cursor: output.nextCursor })).structuredContent;
      expect(next.overview).toBeUndefined();
      expect(next.evidence).toHaveLength(5);
      await expect(getBoardContext({ ...request, detail: detail === "full" ? "auto" : "full", cursor: output.nextCursor })).rejects.toThrow(/detail/);
    }
    await expect(getBoardContext({ ...request, limit: 6, cursor: legacy })).rejects.toThrow(/Cursor does not match/);
    await expect(getBoardContext({ ...request, nodeIds: ["1:0"], cursor: legacy })).rejects.toThrow(/Cursor does not match/);
  });
});
