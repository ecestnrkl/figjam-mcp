import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
const { diffBoardOutputSchema } = await import("../src/schemas/diffBoard.js");
const persistence = await vi.importActual<typeof import("../src/lib/persistentCache.js")>("../src/lib/persistentCache.js");
let cacheRoot: string | undefined;

function snapshot(createdAt: number, text: string): BoardData {
  return {
    boardId: "AbC123",
    fileKey: "AbC123",
    docStructureHint: "freeform",
    createdAt,
    snapshotId: `snapshot-${createdAt}`,
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

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true });
  cacheRoot = undefined;
});

async function persistedHistory(length: number, unchanged: boolean): Promise<void> {
  cacheRoot = await mkdtemp(path.join(tmpdir(), "figjam-diff-freshness-"));
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", cacheRoot);
  readBoardHistoryMock.mockImplementation(persistence.readBoardHistory);
  readCachedBoardMock.mockImplementation(persistence.readCachedBoard);
  for (let version = 1; version <= length; version++) {
    await persistence.persistBoard({
      ...snapshot(version * 1000, `Synthetic version ${version}`),
      cacheKey: `key-${version}`, freshnessCheckedAt: version * 1000,
    });
  }
  if (unchanged) {
    const latest = await persistence.readLatestBoard("AbC123");
    await persistence.persistBoard({ ...latest!, freshnessCheckedAt: (length + 1) * 1000 });
  }
}

describe("diffBoard", () => {
  it("does not report changes between v6 and v7 fingerprints of the same redacted evidence", async () => {
    readBoardHistoryMock.mockResolvedValue([
      { cacheKey: "v6", nodeHash: "old-node-hash", createdAt: 1000 },
      { cacheKey: "v7", nodeHash: "new-node-hash", createdAt: 2000 },
    ]);
    const baseline = snapshot(1000, "PIN: 4711");
    const current = snapshot(2000, "PIN: [redacted]");
    baseline.extractionVersion = 6;
    current.extractionVersion = 7;
    // v6 fingerprints incorporated the raw secret; v7 fingerprints use redacted text.
    baseline.nodes[0]!.contentFingerprint = "raw-pin-fingerprint";
    current.nodes[0]!.contentFingerprint = "redacted-pin-fingerprint";
    readCachedBoardMock.mockImplementation(async (key: string) => key === "v6" ? baseline : current);
    const output = await diffBoard({ boardId: "AbC123", compareTo: 1 });
    const { unchangedClusters, ...changes } = output.stats;
    expect(unchangedClusters).toBe(1);
    expect(Object.values(changes).every((count) => count === 0)).toBe(true);
    expect(output.nodeChanges).toEqual([]);
    expect(output.summaryText).not.toContain("appearance changed");
  });

  it.each(["text", "name", "table"] as const)("still reports a %s edit across extraction versions", async (field) => {
    readBoardHistoryMock.mockResolvedValue([
      { cacheKey: "v6", nodeHash: "old", createdAt: 1000 },
      { cacheKey: "v7", nodeHash: "new", createdAt: 2000 },
    ]);
    const baseline = { ...snapshot(1000, "Same"), extractionVersion: 6 };
    const current = { ...snapshot(2000, "Same"), extractionVersion: 7 };
    if (field === "text") current.nodes[0]!.text = "Edited";
    if (field === "name") current.nodes[0]!.name = "Renamed";
    if (field === "table") {
      baseline.nodes[0]!.table = { cells: [{ id: "cell", text: "Before" }] };
      current.nodes[0]!.table = { cells: [{ id: "cell", text: "After" }] };
    }
    readCachedBoardMock.mockImplementation(async (key: string) => key === "v6" ? baseline : current);
    const output = await diffBoard({ boardId: "AbC123", compareTo: 1 });
    expect(output.stats.editedNodes).toBe(1);
    expect(output.stats.modifiedClusters).toBe(1);
  });

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
    expect(output.baselineSnapshotId).toBe("snapshot-1000");
    expect(output.currentSnapshotId).toBe("snapshot-2000");
    expect(output.tableCellChanges).toEqual([]);
    expect(output.stats.editedNodes).toBe(1);
    expect(output.stats.modifiedClusters).toBe(1);
    expect(output.summaryText).toContain("changes from");
  });

  it("returns a schema-valid empty diff after a later unchanged ingest", async () => {
    readBoardHistoryMock.mockResolvedValue([
      { cacheKey: "k1", refinementId: "r1", nodeHash: "h1", createdAt: 1000 },
    ]);
    const current = { ...snapshot(1000, "Same"), freshnessCheckedAt: 2000 };
    readCachedBoardMock.mockResolvedValue(current);

    const output = await diffBoard({ boardId: "AbC123", compareTo: 1 });

    expect(diffBoardOutputSchema.parse(output)).toEqual(output);
    expect(readCachedBoardMock).toHaveBeenCalledWith("r1");
    expect(output.baselineSnapshotId).toBe("snapshot-1000");
    expect(output.currentSnapshotId).toBe(output.baselineSnapshotId);
    expect(output.baselineCreatedAt).toBe(new Date(1000).toISOString());
    expect(output.currentCreatedAt).toBe(output.baselineCreatedAt);
    const { unchangedClusters, ...changeCounts } = output.stats;
    expect(unchangedClusters).toBe(current.clusters.length);
    expect(Object.values(changeCounts).every((value) => value === 0)).toBe(true);
    for (const list of [output.newClusters, output.removedClusters, output.modifiedClusters,
      output.addedConnections, output.removedConnections, output.tableCellChanges, output.nodeChanges]) expect(list).toEqual([]);
    expect(output.summaryText).toBe("No changes: the board content is the same as at 1970-01-01T00:00:01.000Z; " +
      "the last ingest at 1970-01-01T00:00:02.000Z found it unchanged.");
  });

  it.each([[2, 1], [3, 1], [3, 2]] as const)(
    "announces an unchanged re-ingest with %i persisted snapshots and compareTo %i",
    async (length, compareTo) => {
      await persistedHistory(length, true);
      const output = await diffBoard({ boardId: "AbC123", compareTo: compareTo });
      const createdAt = new Date(length * 1000).toISOString();
      const checkedAt = new Date((length + 1) * 1000).toISOString();
      expect(output.summaryText.startsWith(`No changes since ${createdAt}: the last ingest at ${checkedAt} ` +
        "found the board unchanged. The latest change follows.\n\n")).toBe(true);
      expect(output.summaryText).toContain(`"Synthetic version ${length - compareTo}" → "Synthetic version ${length}"`);
      expect(output.baselineCreatedAt).toBe(new Date((length - compareTo) * 1000).toISOString());
      expect(output.currentCreatedAt).toBe(createdAt);
      expect(output.stats.editedNodes).toBe(1);
      expect(await persistence.readBoardHistory("AbC123")).toHaveLength(length);
      expect(diffBoardOutputSchema.parse(output)).toEqual(output);
    },
  );

  it.each([[2, 1], [3, 1], [3, 2]] as const)(
    "keeps a changed ingest without a freshness preface with %i persisted snapshots and compareTo %i",
    async (length, compareTo) => {
      await persistedHistory(length, false);
      const output = await diffBoard({ boardId: "AbC123", compareTo: compareTo });
      expect(output.summaryText).not.toContain("The latest change follows.");
      expect(output.summaryText).toContain(`"Synthetic version ${length - compareTo}" → "Synthetic version ${length}"`);
      expect(output.stats.editedNodes).toBe(1);
    },
  );

  it.each([undefined, 999, 1000])("keeps the single-snapshot error without a later ingest (%s)", async (freshnessCheckedAt) => {
    readBoardHistoryMock.mockResolvedValue([{ cacheKey: "k1", nodeHash: "h1", createdAt: 1000 }]);
    readCachedBoardMock.mockResolvedValue({ ...snapshot(1000, "Same"), freshnessCheckedAt });
    await expect(diffBoard({ boardId: "AbC123", compareTo: 1 })).rejects.toThrow(/only 1 recorded snapshot/);
  });

  it("keeps the insufficient-history error for compareTo greater than one after an unchanged ingest", async () => {
    readBoardHistoryMock.mockResolvedValue([{ cacheKey: "k1", nodeHash: "h1", createdAt: 1000 }]);
    readCachedBoardMock.mockResolvedValue({ ...snapshot(1000, "Same"), freshnessCheckedAt: 2000 });
    await expect(diffBoard({ boardId: "AbC123", compareTo: 2 })).rejects.toThrow(/only 1 recorded snapshot/);
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

  it("names edited nodes with redacted text and passes the output schema", async () => {
    readBoardHistoryMock.mockResolvedValue([
      { cacheKey: "k1", nodeHash: "h1", createdAt: 1000 },
      { cacheKey: "k2", nodeHash: "h2", createdAt: 2000 },
    ]);
    // Snapshots cached before redaction existed still hold the raw values.
    readCachedBoardMock.mockImplementation(async (cacheKey: string) => cacheKey === "k1"
      ? snapshot(1000, "Café Wi-Fi\npassword: hunter2") : snapshot(2000, "Café Wi-Fi in the pilot room\npassword: hunter3"));

    const output = await diffBoard({ boardId: "AbC123", compareTo: 1 });

    expect(diffBoardOutputSchema.parse(output)).toEqual(output);
    expect(output.nodeChanges).toEqual([{
      nodeId: "1:1", changeType: "edited", nodeType: "STICKY",
      previousText: "Café Wi-Fi password: [redacted]", currentText: "Café Wi-Fi in the pilot room password: [redacted]",
      url: "https://www.figma.com/board/AbC123?node-id=1%3A1", changes: ["text"],
    }]);
    expect(output.summaryText).toContain('- sticky 1:1 outside sections: "Café Wi-Fi password: [redacted]" → ' +
      '"Café Wi-Fi in the pilot room password: [redacted]"');
    expect(JSON.stringify(output)).not.toMatch(/hunter/);
  });
});
