import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardData } from "../src/types.js";

const original = { ...process.env };
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "figjam-lookup-")); process.env.FIGJAM_MCP_CACHE_DIR = root; vi.resetModules(); });
afterEach(async () => { process.env = { ...original }; await rm(root, { recursive: true, force: true }); });

function board(fileKey: string, createdAt: number): BoardData {
  return { boardId: fileKey, fileKey, docStructureHint: "freeform", cacheKey: `key-${fileKey}`, createdAt,
    nodes: [{ id: "1:1", name: "Sticky", type: "STICKY", x: 0, y: 0, width: 100, height: 100, rotation: 0, text: `Secret board text of ${fileKey}` }],
    clusters: [{ id: "c1", nodeIds: ["1:1"], confirmedNodeIds: ["1:1"], label: "Notes", summary: "Notes", summarySource: "deterministic", incomplete: false, boundingBox: { x: 0, y: 0, width: 100, height: 100 } }] };
}
const at = (month: number, day: number, hour: number, minute: number) => Date.UTC(2026, month - 1, day, hour, minute, 30);

async function store(...boards: Array<[string, number]>) {
  const cache = await import("../src/lib/persistentCache.js");
  for (const [fileKey, createdAt] of boards) await cache.persistBoard(board(fileKey, createdAt));
}
const lookup = async (lead: string, boardId: string) => (await import("../src/lib/boardLookup.js")).unknownBoardMessage(lead, boardId);

describe("unknown boardId", () => {
  it("lists the stored boards, most recent first, with the minute of their last ingest in UTC and no board content", async () => {
    await store(["AbC123", at(11, 3, 9, 5)], ["Other456", at(11, 5, 10, 12)]);
    const message = await lookup('Board "Nope999" not found.', "Nope999");
    expect(message).toBe('Board "Nope999" not found. Stored boards, most recent first: Other456 (last ingest 2026-11-05 10:12 UTC), '
      + "AbC123 (last ingest 2026-11-03 09:05 UTC). boardId is the Figma file key from the board URL (figma.com/board/<key>/…). "
      + "For another board, run ingest_board first.");
    expect(message).not.toContain("Secret board text");
    expect(message).not.toContain("Did you mean");
  });

  it("starts with the stored key that differs only in case and rewrites nothing", async () => {
    await store(["AbC123", at(11, 3, 9, 5)], ["Other456", at(11, 5, 10, 12)]);
    const message = await lookup('Board "abc123" not found.', "abc123");
    expect(message).toMatch(/^Did you mean AbC123\? File keys are case-sensitive\. Board "abc123" not found\. Stored boards/);
    expect(message).toContain("Other456 (last ingest 2026-11-05 10:12 UTC)");
  });

  it("keeps the hint to run ingest_board when nothing is stored", async () => {
    const message = await lookup('No ingest history for board "AbC123".', "AbC123");
    expect(message).toBe('No ingest history for board "AbC123". Run ingest_board first. boardId is the Figma file key from the board URL (figma.com/board/<key>/…).');
  });

  it("names at most 10 boards and counts the rest", async () => {
    await store(...Array.from({ length: 12 }, (_, index) => [`Board${String(index).padStart(2, "0")}`, at(11, 1, 8, index)] as [string, number]));
    const message = await lookup('Board "Nope999" not found.', "Nope999");
    expect(message.match(/Board\d\d \(last ingest/g)).toHaveLength(10);
    expect(message).toContain("Board11 (last ingest 2026-11-01 08:11 UTC)");
    expect(message).not.toContain("Board01 ");
    expect(message).toContain("and 2 more");
  });

  it("finds the right key beyond the ten listed boards", async () => {
    await store(...Array.from({ length: 12 }, (_, index) => [`Board${String(index).padStart(2, "0")}`, at(11, 1, 8, index)] as [string, number]));
    expect(await lookup('Board "board00" not found.', "board00")).toMatch(/^Did you mean Board00\?/);
  });

  it.each([
    ["get_board_context", async () => (await import("../src/tools/getBoardContext.js")).getBoardContext({ boardId: "abc123" })],
    ["answer_from_board", async () => (await import("../src/tools/answerFromBoard.js")).answerFromBoard({ boardId: "abc123", question: "What?" })],
    ["diff_board", async () => (await import("../src/tools/diffBoard.js")).diffBoard({ boardId: "abc123", compareTo: 1 })],
  ])("%s answers it with the stored boards", async (_name, run) => {
    await store(["AbC123", at(11, 3, 9, 5)], ["Other456", at(11, 5, 10, 12)]);
    await expect(run()).rejects.toThrow(/^Did you mean AbC123\? File keys are case-sensitive\. .*Stored boards, most recent first: Other456 \(last ingest 2026-11-05 10:12 UTC\), AbC123/);
  });

  it.each([
    ["get_board_context", async () => (await import("../src/tools/getBoardContext.js")).getBoardContext({ boardId: "AbC123" }), 'Board "AbC123" not found.'],
    ["answer_from_board", async () => (await import("../src/tools/answerFromBoard.js")).answerFromBoard({ boardId: "AbC123", question: "What?" }), 'Board "AbC123" not found.'],
    ["diff_board", async () => (await import("../src/tools/diffBoard.js")).diffBoard({ boardId: "AbC123", compareTo: 1 }), 'No ingest history for board "AbC123".'],
  ])("%s keeps the hint to run ingest_board with an empty cache", async (_name, run, lead) => {
    await expect(run()).rejects.toThrow(`${lead} Run ingest_board first. boardId is the Figma file key from the board URL`);
  });

  it("takes the file key of a board URL as boardId in all three tools", async () => {
    await store(["AbC123", at(11, 3, 9, 5)], ["Other456", at(11, 5, 10, 12)]);
    const url = "https://www.figma.com/board/Nope999/Example?node-id=5-87";
    await expect((await import("../src/tools/getBoardContext.js")).getBoardContext({ boardId: url })).rejects.toThrow('Board "Nope999" not found.');
    await expect((await import("../src/tools/answerFromBoard.js")).answerFromBoard({ boardId: url, question: "What?" })).rejects.toThrow('Board "Nope999" not found.');
    await expect((await import("../src/tools/diffBoard.js")).diffBoard({ boardId: url, compareTo: 1 })).rejects.toThrow('No ingest history for board "Nope999".');
  });
});
