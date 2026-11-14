import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardData } from "../src/types.js";
import { evidenceBoard, textNode } from "./fixtures/retrieval.js";

const { chatJsonMock } = vi.hoisted(() => ({ chatJsonMock: vi.fn() }));
vi.mock("../src/lib/llmClient.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/llmClient.js")>(), chatJson: chatJsonMock,
}));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "figjam-readers-"));
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", root);
  vi.resetModules();
  chatJsonMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
function board(text: string, createdAt: number): BoardData {
  return { ...evidenceBoard("Synthetic123", [textNode("1:1", text)]), cacheKey: `key-${createdAt}`, createdAt };
}
async function corruptNewest(all = false, artifact: "source" | "refinement" = "source"): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(root, "v4", "board-Synthetic123.json"), "utf8"));
  const entries: Array<{ snapshotId: string; refinementId: string }> = all ? manifest.history : manifest.history.slice(-1);
  await Promise.all(entries.map(entry => writeFile(path.join(root, "v4", `${artifact}-${artifact === "source" ? entry.snapshotId : entry.refinementId}.json`), '{"schemaVersion":')));
}

describe("snapshot readers", () => {
  it.each(["01234567", "0123456789abcdef".repeat(4)])("explains an unknown snapshot ID %s", async (snapshotId) => {
    const { getBoardContext } = await import("../src/tools/getBoardContext.js");
    const { persistBoard } = await import("../src/lib/persistentCache.js");
    await persistBoard(board("Saved synthetic snapshot", 1000));
    await expect(getBoardContext({ boardId: "Synthetic123", snapshotId })).rejects.toThrow(
      `Snapshot ${snapshotId.slice(0, 12)} of board "Synthetic123" is missing from local history. `
      + (snapshotId.length < 64 ? "Use the full snapshot ID to read a specific snapshot. " : "")
      + "Omit snapshotId to read the latest ingest, or run ingest_board.");
  });
  it("explains how to restart a cursor read with an expired full snapshot ID or its short prefix", async () => {
    const { getBoardContext } = await import("../src/tools/getBoardContext.js");
    const { persistBoard, readBoardHistory } = await import("../src/lib/persistentCache.js");
    const initial = board("Old snapshot", 1000);
    initial.nodes.push(textNode("1:2", "Second excerpt"));
    await persistBoard(initial);
    const { structuredContent: first } = await getBoardContext({ boardId: initial.boardId, limit: 1 });
    expect(first.nextCursor).toBeDefined();
    for (let revision = 1; revision <= 20; revision++) {
      await persistBoard(board(`Synthetic revision ${revision}`, 1000 + revision));
    }
    expect((await readBoardHistory(initial.boardId)).some(entry => entry.snapshotId === first.snapshotId)).toBe(false);
    // A fresh server cannot serve the first snapshot from its in-memory head.
    vi.resetModules();
    const { getBoardContext: restartedContext } = await import("../src/tools/getBoardContext.js");
    const request = { boardId: initial.boardId, limit: 1, cursor: first.nextCursor };
    await expect(restartedContext({ ...request, snapshotId: first.snapshotId })).rejects.toThrow("Omit both cursor and snapshotId");
    await expect(restartedContext({ ...request, snapshotId: first.snapshotId.slice(0, 12) }))
      .rejects.toThrow(/Use the full snapshot ID.*Omit both cursor and snapshotId/);
  });
  it("refreshes both in-process server instances after the other publishes", async () => {
    const cacheA = await import("../src/lib/cache.js");
    const persistenceA = await import("../src/lib/persistentCache.js");
    const contextA = await import("../src/tools/getBoardContext.js");
    const diffA = await import("../src/tools/diffBoard.js");
    vi.resetModules();
    const cacheB = await import("../src/lib/cache.js");
    const persistenceB = await import("../src/lib/persistentCache.js");
    const contextB = await import("../src/tools/getBoardContext.js");
    const diffB = await import("../src/tools/diffBoard.js");
    const initial = board("Initial synthetic text", 1000);
    cacheA.setBoard(initial.boardId, initial, (await persistenceA.persistBoard(initial))?.revisionId);
    expect((await contextB.getBoardContext({ boardId: initial.boardId })).text).toContain("Initial synthetic text");
    for (const [writer, persistence, reader, diff, text, time] of [
      [cacheA, persistenceA, contextB, diffB, "A synthetic update", 2000],
      [cacheB, persistenceB, contextA, diffA, "B synthetic update", 3000],
    ] as const) {
      const updated = board(text, time);
      writer.setBoard(updated.boardId, updated, (await persistence.persistBoard(updated))?.revisionId);
      const context = await reader.getBoardContext({ boardId: updated.boardId });
      expect(context.text).toContain(text);
      expect(context.structuredContent.snapshotId).toBe((await diff.diffBoard({ boardId: updated.boardId, compareTo: 1 })).currentSnapshotId);
    }
    const old = await cacheA.getBoardOrRestore(initial.boardId, persistenceA.buildSnapshotId(initial.fileKey, persistenceA.hashNormalizedNodes(initial.nodes)));
    expect(old?.nodes[0]?.text).toBe("Initial synthetic text");
  });

  it.each(["unchanged source", "changed source", "no saved head"] as const)("keeps a failed publication in memory until a later publish after %s", async (scenario) => {
    const cache = await import("../src/lib/cache.js");
    const persistence = await import("../src/lib/persistentCache.js");
    const initial = board("Saved original", 1000);
    if (scenario !== "no saved head") await persistence.persistBoard(initial);
    const failed = board(scenario === "unchanged source" ? "Saved original" : "Unsaved new source", scenario === "unchanged source" ? 1000 : 2000);
    failed.clusters[0]!.summary = "Unsaved interpretation";
    const head = (await persistence.readBoardHistory(initial.boardId)).at(-1);
    cache.setBoard(failed.boardId, failed, head?.refinementId ?? head?.cacheKey ?? null);
    expect(await cache.getBoardOrRestore(initial.boardId)).toBe(failed);
    // Another server republishes the original source; its capture timestamp stays old.
    vi.resetModules();
    const otherPersistence = await import("../src/lib/persistentCache.js");
    const published = { ...initial, cacheKey: "republished-original" };
    published.clusters[0]!.summary = "Published interpretation";
    await otherPersistence.persistBoard(published);
    const refreshed = await cache.getBoardOrRestore(initial.boardId);
    expect(refreshed?.nodes[0]?.text).toBe("Saved original");
    expect(refreshed?.clusters[0]?.summary).toBe("Published interpretation");
  });

  it.each([
    ["get_board_context", "source"], ["get_board_context", "refinement"],
    ["answer_from_board", "source"], ["answer_from_board", "refinement"],
  ] as const)("%s falls back after a damaged %s with its date and remedy", async (tool, artifact) => {
    const persistence = await import("../src/lib/persistentCache.js");
    await persistence.persistBoard(board("Readable synthetic version", 1000));
    await persistence.persistBoard(board("Damaged synthetic version", 2000));
    await corruptNewest(false, artifact);
    let output: string;
    if (tool === "get_board_context") {
      const { getBoardContext } = await import("../src/tools/getBoardContext.js");
      const result = await getBoardContext({ boardId: "Synthetic123" });
      output = result.text;
      expect(result.structuredContent.contextText).toContain("using the snapshot from 1970-01-01T00:00:01.000Z");
    } else {
      chatJsonMock.mockResolvedValue({});
      const { answerFromBoard } = await import("../src/tools/answerFromBoard.js");
      output = (await answerFromBoard({ boardId: "Synthetic123", question: "synthetic version?" })).answer;
    }
    expect(output).toContain("Readable synthetic version");
    expect(output).not.toContain("Damaged synthetic version");
    expect(output).toContain("The latest cached snapshot cannot be read (damaged files); using the snapshot from 1970-01-01T00:00:01.000Z; run ingest_board to rebuild.");
  });

  it.each(["get_board_context", "answer_from_board"] as const)("%s reports damaged snapshots instead of a missing board when all are unreadable", async (tool) => {
    const persistence = await import("../src/lib/persistentCache.js");
    await persistence.persistBoard(board("First", 1000));
    await persistence.persistBoard(board("Second", 2000));
    await corruptNewest(true);
    const { getBoardContext } = await import("../src/tools/getBoardContext.js");
    const { answerFromBoard } = await import("../src/tools/answerFromBoard.js");
    await expect(tool === "get_board_context" ? getBoardContext({ boardId: "Synthetic123" })
      : answerFromBoard({ boardId: "Synthetic123", question: "synthetic version?" }))
      .rejects.toThrow('The cached snapshots of board "Synthetic123" cannot be read (damaged files); run ingest_board to rebuild them.');
    expect(chatJsonMock).not.toHaveBeenCalled();
  });

  it.each(["get_board_context", "answer_from_board"] as const)("%s keeps an explicitly requested damaged snapshot instead of falling back", async (tool) => {
    const persistence = await import("../src/lib/persistentCache.js");
    await persistence.persistBoard(board("Readable previous source", 1000));
    await persistence.persistBoard(board("Requested damaged source", 2000));
    const snapshotId = (await persistence.readBoardHistory("Synthetic123")).at(-1)!.snapshotId!;
    await corruptNewest();
    const { getBoardContext } = await import("../src/tools/getBoardContext.js");
    const { answerFromBoard } = await import("../src/tools/answerFromBoard.js");
    await expect(tool === "get_board_context" ? getBoardContext({ boardId: "Synthetic123", snapshotId })
      : answerFromBoard({ boardId: "Synthetic123", snapshotId, question: "synthetic source?" }))
      .rejects.toThrow('The requested snapshot of board "Synthetic123" cannot be read (damaged files); run ingest_board to rebuild it.');
    expect(chatJsonMock).not.toHaveBeenCalled();
  });

  it.each(["baseline", "current"] as const)("diff_board identifies an unreadable %s without claiming it is no longer cached", async (target) => {
    const persistence = await import("../src/lib/persistentCache.js");
    await persistence.persistBoard(board("Before", 1000));
    await persistence.persistBoard(board("After", 2000));
    const history = await persistence.readBoardHistory("Synthetic123");
    await writeFile(path.join(root, "v4", `refinement-${history[target === "baseline" ? 0 : 1]!.refinementId}.json`), "{");
    const { diffBoard } = await import("../src/tools/diffBoard.js");
    await expect(diffBoard({ boardId: "Synthetic123", compareTo: 1 })).rejects.toThrow('A comparison snapshot of board "Synthetic123" cannot be read (damaged files); run ingest_board to rebuild it.');
  });

});
