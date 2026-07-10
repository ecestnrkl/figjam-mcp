import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardData } from "../src/types.js";

const { readBoardHistoryMock, readCachedBoardMock } = vi.hoisted(() => ({
  readBoardHistoryMock: vi.fn(),
  readCachedBoardMock: vi.fn(),
}));

vi.mock("../src/lib/persistentCache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/persistentCache.js")>()),
  readBoardHistory: readBoardHistoryMock,
  readCachedBoard: readCachedBoardMock,
}));

const { diffBoard } = await import("../src/tools/diffBoard.js");

function snapshot(createdAt: number, text: string): BoardData {
  return {
    boardId: "AbC123",
    fileKey: "AbC123",
    docStructureHint: "freeform",
    createdAt,
    nodes: [
      {
        id: "1:1",
        name: "Sticky",
        type: "STICKY",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        rotation: 0,
        text,
      },
    ],
    clusters: [
      {
        id: "cluster_1",
        label: "Notes",
        summary: "Notes summary.",
        nodeIds: ["1:1"],
        confirmedNodeIds: ["1:1"],
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      },
    ],
    connectorEdges: [],
    clusterRelations: [],
  };
}

beforeEach(() => {
  readBoardHistoryMock.mockResolvedValue([]);
  readCachedBoardMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("diffBoard", () => {
  it("fails without ingest history", async () => {
    await expect(diffBoard({ boardId: "AbC123", compareTo: 1 })).rejects.toThrow(
      /No ingest history/,
    );
  });

  it("fails when only one snapshot exists", async () => {
    readBoardHistoryMock.mockResolvedValue([
      { cacheKey: "k1", nodeHash: "h1", createdAt: 1000 },
    ]);

    await expect(diffBoard({ boardId: "AbC123", compareTo: 1 })).rejects.toThrow(
      /only 1 recorded snapshot/,
    );
  });

  it("diffs the two most recent snapshots", async () => {
    readBoardHistoryMock.mockResolvedValue([
      { cacheKey: "k1", nodeHash: "h1", createdAt: 1000 },
      { cacheKey: "k2", nodeHash: "h2", createdAt: 2000 },
    ]);
    readCachedBoardMock.mockImplementation(async (cacheKey: string) =>
      cacheKey === "k1" ? snapshot(1000, "Before") : snapshot(2000, "After"),
    );

    const output = await diffBoard({ boardId: "AbC123", compareTo: 1 });

    expect(output.baselineCreatedAt).toBe(new Date(1000).toISOString());
    expect(output.currentCreatedAt).toBe(new Date(2000).toISOString());
    expect(output.stats.editedNodes).toBe(1);
    expect(output.stats.modifiedClusters).toBe(1);
    expect(output.summaryText).toContain("changes from");
  });

  it("fails when a snapshot was evicted from the cache", async () => {
    readBoardHistoryMock.mockResolvedValue([
      { cacheKey: "k1", nodeHash: "h1", createdAt: 1000 },
      { cacheKey: "k2", nodeHash: "h2", createdAt: 2000 },
    ]);
    readCachedBoardMock.mockResolvedValue(undefined);

    await expect(diffBoard({ boardId: "AbC123", compareTo: 1 })).rejects.toThrow(
      /no longer cached/,
    );
  });
});
