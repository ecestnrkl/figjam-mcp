import { describe, expect, it } from "vitest";
import { setBoard } from "../src/lib/cache.js";
import { retrieveEvidence } from "../src/lib/evidence.js";
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
    const internal = retrieveEvidence(data).evidence[0]!;
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
