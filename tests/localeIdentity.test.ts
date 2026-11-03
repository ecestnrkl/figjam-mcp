import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BoardData, NormalizedNode } from "../src/types.js";
import { flattenNodeTree } from "../src/lib/nodeTree.js";
import { partitionedBoardClusters } from "../src/lib/spatialCluster.js";
import { buildBoardCacheKey, buildSnapshotId, hashClusterNodes, hashNormalizedNodes, persistBoard, readLatestBoard } from "../src/lib/persistentCache.js";
import { setBoard } from "../src/lib/cache.js";
import { getBoardContext } from "../src/tools/getBoardContext.js";

const original = { ...process.env };
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "figjam-locale-"));
  process.env.FIGJAM_MCP_CACHE_DIR = directory;
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...original };
  await rm(directory, { recursive: true, force: true });
});

function nodes(): NormalizedNode[] {
  return flattenNodeTree({ document: { id: "document", name: "Document", type: "DOCUMENT", children:
    ["ž", "A", "ä", "z"].map((id) => ({ id: `page-${id}`, name: id, type: "CANVAS", children:
      ["ž", "A", "ä", "z"].map((suffix) => ({
        id: `${id}-${suffix}`, name: "Sticky", type: "STICKY", characters: `Source ${id} ${suffix}`,
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        fills: [{ type: "SOLID", color: { r: 1, b: 0, g: 1 } }],
      })),
    })),
  } });
}

function board(): BoardData {
  const source = nodes();
  const nodeHash = hashNormalizedNodes(source);
  const clusters = partitionedBoardClusters(source, { maxClusterSize: 2 });
  return {
    boardId: "Locale123", fileKey: "Locale123", docStructureHint: "freeform", ingestMode: "max_speed", createdAt: 1,
    nodeHash, snapshotId: buildSnapshotId("Locale123", nodeHash), extractionVersion: 7,
    cacheKey: buildBoardCacheKey({ fileKey: "Locale123", nodeHash, docStructureHint: "freeform", ingestMode: "max_speed" }),
    nodes: source,
    clusters: clusters.map((cluster) => ({ ...cluster, confirmedNodeIds: cluster.nodeIds, label: "Notes",
      summary: "Original board excerpts.", summarySource: "deterministic" })),
  };
}

async function pages(data: BoardData) {
  setBoard(data.boardId, data);
  const result = [];
  let cursor: string | undefined;
  do {
    const page = await getBoardContext({ boardId: data.boardId, detail: "full", limit: 2, maxChars: 24000, cursor });
    result.push(page);
    cursor = page.structuredContent.nextCursor;
  } while (cursor);
  return result;
}

it("keeps snapshot/cache identity, cluster membership, output pages and cursors independent of localeCompare", async () => {
  const baseline = board();
  const baselinePages = await pages(baseline);
  expect(baselinePages.length).toBeGreaterThan(1);
  await persistBoard(baseline);
  const originalClusterHash = hashClusterNodes(baseline.nodes);
  vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (this: string, other: string) {
    return this < other ? 1 : this > other ? -1 : 0;
  });
  const reorderedLocale = board();
  expect(reorderedLocale).toEqual(baseline);
  expect(hashClusterNodes(reorderedLocale.nodes)).toBe(originalClusterHash);
  expect(await readLatestBoard(baseline.fileKey)).toMatchObject({ snapshotId: baseline.snapshotId, cacheKey: baseline.cacheKey });
  expect(await pages(reorderedLocale)).toEqual(baselinePages);
});
