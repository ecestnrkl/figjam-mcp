import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardData, NormalizedNode } from "../src/types.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

function node(id: string, text: string): NormalizedNode {
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
  };
}

describe("persistentCache", () => {
  it("misses before write and hits after write", async () => {
    process.env.FIGJAM_MCP_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "figjam-cache-"));
    const {
      buildBoardCacheKey,
      hashNormalizedNodes,
      readCachedBoard,
      writeCachedBoard,
    } = await import("../src/lib/persistentCache.js");

    const nodes = [node("1:1", "Hello")];
    const cacheKey = buildBoardCacheKey({
      fileKey: "file-a",
      figmaLastModified: "2026-07-04T00:00:00Z",
      nodeHash: hashNormalizedNodes(nodes),
      docStructureHint: "freeform",
      ingestMode: "balanced",
    });

    await expect(readCachedBoard(cacheKey)).resolves.toBeUndefined();

    const board: BoardData = {
      boardId: "file-a",
      fileKey: "file-a",
      docStructureHint: "freeform",
      ingestMode: "balanced",
      nodes,
      clusters: [],
      createdAt: 1,
    };
    await writeCachedBoard(cacheKey, board);

    await expect(readCachedBoard(cacheKey)).resolves.toMatchObject({
      boardId: "file-a",
      ingestMode: "balanced",
    });
    await expect(readFile(path.join(process.env.FIGJAM_MCP_CACHE_DIR, `${cacheKey}.json`), "utf8"))
      .resolves.toBe(`${JSON.stringify(board)}\n`);
  });

  it("changes the node hash when extracted text changes", async () => {
    const { hashNormalizedNodes } = await import("../src/lib/persistentCache.js");

    expect(hashNormalizedNodes([node("1:1", "A")])).not.toBe(
      hashNormalizedNodes([node("1:1", "B")]),
    );
  });

  it("restores the latest board for a file key via the pointer", async () => {
    process.env.FIGJAM_MCP_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "figjam-cache-"));
    const { readLatestBoard, writeCachedBoard, writeLatestBoardPointer } = await import(
      "../src/lib/persistentCache.js"
    );

    await expect(readLatestBoard("file-b")).resolves.toBeUndefined();

    const board: BoardData = {
      boardId: "file-b",
      fileKey: "file-b",
      docStructureHint: "freeform",
      nodes: [],
      clusters: [],
      createdAt: 1,
    };
    await writeCachedBoard("some-cache-key", board);
    await writeLatestBoardPointer("file-b", "some-cache-key");

    await expect(readLatestBoard("file-b")).resolves.toMatchObject({ boardId: "file-b" });
    await expect(
      readFile(path.join(process.env.FIGJAM_MCP_CACHE_DIR, "latest-file-b.json"), "utf8"),
    ).resolves.toBe(`${JSON.stringify({ cacheKey: "some-cache-key", schemaVersion: 3 })}\n`);
  });

  it("does not restore snapshots through latest pointers from an older schema", async () => {
    process.env.FIGJAM_MCP_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "figjam-cache-"));
    const { readLatestBoard, writeCachedBoard } = await import(
      "../src/lib/persistentCache.js"
    );
    const legacyBoard: BoardData = {
      boardId: "file-legacy",
      fileKey: "file-legacy",
      docStructureHint: "freeform",
      nodes: [],
      clusters: [],
      createdAt: 1,
    };
    await writeCachedBoard("legacy-cache-key", legacyBoard);

    // v2/latest pointers did not carry a schema version. They must miss after
    // an upgrade instead of bypassing buildBoardCacheKey's schema invalidation.
    await writeFile(
      path.join(process.env.FIGJAM_MCP_CACHE_DIR, "latest-file-legacy.json"),
      `${JSON.stringify({ cacheKey: "legacy-cache-key" })}\n`,
      "utf8",
    );
    await expect(readLatestBoard("file-legacy")).resolves.toBeUndefined();

    await writeFile(
      path.join(process.env.FIGJAM_MCP_CACHE_DIR, "latest-file-legacy.json"),
      `${JSON.stringify({ cacheKey: "legacy-cache-key", schemaVersion: 2 })}\n`,
      "utf8",
    );
    await expect(readLatestBoard("file-legacy")).resolves.toBeUndefined();
  });

  it("appends, dedupes, and caps the board history", async () => {
    process.env.FIGJAM_MCP_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "figjam-cache-"));
    const { readBoardHistory, writeBoardHistoryEntry } = await import(
      "../src/lib/persistentCache.js"
    );

    await expect(readBoardHistory("file-h")).resolves.toEqual([]);

    await writeBoardHistoryEntry("file-h", { cacheKey: "k1", nodeHash: "h1", createdAt: 1 });
    await writeBoardHistoryEntry("file-h", { cacheKey: "k2", nodeHash: "h2", createdAt: 2 });
    // Same cacheKey as the newest entry → deduped.
    await writeBoardHistoryEntry("file-h", { cacheKey: "k2", nodeHash: "h2", createdAt: 3 });

    const history = await readBoardHistory("file-h");
    expect(history.map((entry) => entry.cacheKey)).toEqual(["k1", "k2"]);

    // 25 distinct snapshots → capped to the newest 20.
    for (let i = 0; i < 25; i++) {
      await writeBoardHistoryEntry("file-cap", {
        cacheKey: `k${i}`,
        nodeHash: `h${i}`,
        createdAt: i,
      });
    }
    const capped = await readBoardHistory("file-cap");
    expect(capped).toHaveLength(20);
    expect(capped[0]?.cacheKey).toBe("k5");
    expect(capped.at(-1)?.cacheKey).toBe("k24");
  });

  it("serializes parallel history updates without losing entries", async () => {
    process.env.FIGJAM_MCP_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "figjam-cache-"));
    const { readBoardHistory, writeBoardHistoryEntry } = await import(
      "../src/lib/persistentCache.js"
    );

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        writeBoardHistoryEntry("file-parallel", {
          cacheKey: `parallel-${index}`,
          nodeHash: `hash-${index}`,
          createdAt: index,
        }),
      ),
    );

    const history = await readBoardHistory("file-parallel");
    expect(history.map((entry) => entry.cacheKey)).toEqual(
      Array.from({ length: 20 }, (_, index) => `parallel-${index + 5}`),
    );
  });

  it("deletes only unreferenced snapshots dropped from this board's history", async () => {
    process.env.FIGJAM_MCP_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "figjam-cache-"));
    const {
      readBoardHistory,
      readCachedBoard,
      writeBoardHistoryEntry,
      writeCachedBoard,
      writeLatestBoardPointer,
    } = await import("../src/lib/persistentCache.js");

    const snapshot = (fileKey: string, createdAt: number): BoardData => ({
      boardId: fileKey,
      fileKey,
      docStructureHint: "freeform",
      nodes: [],
      clusters: [],
      createdAt,
    });
    const addHistorySnapshot = async (cacheKey: string, fileKey: string, createdAt: number) => {
      await writeCachedBoard(cacheKey, snapshot(fileKey, createdAt));
      await writeBoardHistoryEntry("file-gc", {
        cacheKey,
        nodeHash: `hash-${cacheKey}`,
        createdAt,
      });
    };

    // Even if a damaged/mixed history mentions it, another board's snapshot
    // must not be removed by file-gc's retention pass.
    await addHistorySnapshot("foreign-unreferenced", "file-other", 0);
    await addHistorySnapshot("foreign-latest", "file-other", 1);
    await writeLatestBoardPointer("file-other", "foreign-latest");

    for (let i = 0; i < 20; i++) {
      await addHistorySnapshot(`k${i}`, "file-gc", i + 2);
    }

    // A latest pointer is a live reference even after its history entry ages out.
    await writeLatestBoardPointer("file-gc", "k0");
    await addHistorySnapshot("k20", "file-gc", 22);
    await addHistorySnapshot("k21", "file-gc", 23);

    await expect(readCachedBoard("foreign-unreferenced")).resolves.toBeDefined();
    await expect(readCachedBoard("foreign-latest")).resolves.toBeDefined();
    await expect(readCachedBoard("k0")).resolves.toBeDefined();
    await expect(readCachedBoard("k1")).resolves.toBeUndefined();

    const history = await readBoardHistory("file-gc");
    expect(history).toHaveLength(20);
    expect(history[0]?.cacheKey).toBe("k2");
    expect(history.at(-1)?.cacheKey).toBe("k21");
  });

  it("keeps a dropped snapshot referenced by another board's history", async () => {
    process.env.FIGJAM_MCP_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "figjam-cache-"));
    const { readCachedBoard, writeBoardHistoryEntry, writeCachedBoard } = await import(
      "../src/lib/persistentCache.js"
    );
    const snapshot: BoardData = {
      boardId: "file-history-owner",
      fileKey: "file-history-owner",
      docStructureHint: "freeform",
      nodes: [],
      clusters: [],
      createdAt: 0,
    };

    await writeCachedBoard("shared-history-key", snapshot);
    await writeBoardHistoryEntry("file-history-owner", {
      cacheKey: "shared-history-key",
      nodeHash: "shared-hash",
      createdAt: 0,
    });
    await writeBoardHistoryEntry("history-other", {
      cacheKey: "shared-history-key",
      nodeHash: "shared-hash",
      createdAt: 0,
    });

    for (let index = 1; index <= 20; index++) {
      const cacheKey = `owner-${index}`;
      await writeCachedBoard(cacheKey, { ...snapshot, createdAt: index });
      await writeBoardHistoryEntry("file-history-owner", {
        cacheKey,
        nodeHash: `hash-${index}`,
        createdAt: index,
      });
    }

    await expect(readCachedBoard("shared-history-key")).resolves.toBeDefined();
  });

  it("fails closed when any cache reference file is malformed", async () => {
    process.env.FIGJAM_MCP_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "figjam-cache-"));
    const { readCachedBoard, writeBoardHistoryEntry, writeCachedBoard } = await import(
      "../src/lib/persistentCache.js"
    );
    const snapshot: BoardData = {
      boardId: "file-safe-gc",
      fileKey: "file-safe-gc",
      docStructureHint: "freeform",
      nodes: [],
      clusters: [],
      createdAt: 1,
    };

    for (let i = 0; i < 20; i++) {
      await writeCachedBoard(`safe-${i}`, { ...snapshot, createdAt: i });
      await writeBoardHistoryEntry("file-safe-gc", {
        cacheKey: `safe-${i}`,
        nodeHash: `hash-${i}`,
        createdAt: i,
      });
    }

    await writeFile(
      path.join(process.env.FIGJAM_MCP_CACHE_DIR, "history-corrupt.json"),
      '{"not":"an array"}\n',
      "utf8",
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await writeCachedBoard("safe-20", { ...snapshot, createdAt: 20 });
    await writeBoardHistoryEntry("file-safe-gc", {
      cacheKey: "safe-20",
      nodeHash: "hash-20",
      createdAt: 20,
    });

    await expect(readCachedBoard("safe-0")).resolves.toBeDefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Snapshot cleanup skipped"));
    errorSpy.mockRestore();
  });

  it("getBoardOrRestore falls back to the persisted board after a restart", async () => {
    process.env.FIGJAM_MCP_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "figjam-cache-"));
    const { writeCachedBoard, writeLatestBoardPointer } = await import(
      "../src/lib/persistentCache.js"
    );

    const board: BoardData = {
      boardId: "file-c",
      fileKey: "file-c",
      docStructureHint: "freeform",
      nodes: [],
      clusters: [
        {
          id: "cluster_1",
          label: "Restored",
          summary: "Restored summary.",
          nodeIds: ["1:1"],
          confirmedNodeIds: ["1:1"],
          boundingBox: { x: 0, y: 0, width: 100, height: 100 },
          summarySource: "vision_llm",
        },
      ],
      createdAt: 1,
    };
    await writeCachedBoard("restart-cache-key", board);
    await writeLatestBoardPointer("file-c", "restart-cache-key");

    // Fresh import = empty in-memory map, like after a server restart.
    const { getBoardOrRestore } = await import("../src/lib/cache.js");

    const restored = await getBoardOrRestore("file-c");
    expect(restored?.clusters[0]).toMatchObject({
      label: "Restored",
      summarySource: "cache",
    });

    await expect(getBoardOrRestore("missing-file")).resolves.toBeUndefined();
  });
});
