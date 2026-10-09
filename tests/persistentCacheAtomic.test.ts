import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BoardData } from "../src/types.js";

const hooks = vi.hoisted(() => ({ afterRename: undefined as ((destination: string) => void) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    await actual.rename(...args); hooks.afterRename?.(String(args[1]));
  } };
});
let root: string;
afterEach(async () => { hooks.afterRename = undefined; vi.unstubAllEnvs(); vi.resetModules(); if (root) await rm(root, { recursive: true, force: true }); });

it("an abort after refinement staging cannot overwrite the previously committed interpretation", async () => {
  root = await mkdtemp(path.join(tmpdir(), "figjam-atomic-"));
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", root);
  const cache = await import("../src/lib/persistentCache.js");
  const board: BoardData = { boardId: "abc", fileKey: "abc", cacheKey: "same-logical-key", createdAt: 1,
    docStructureHint: "freeform", nodes: [{ id: "n", name: "Sticky", type: "STICKY", text: "Original", x: 0, y: 0, width: 100, height: 100, rotation: 0 }],
    clusters: [{ id: "c", nodeIds: ["n"], confirmedNodeIds: ["n"], label: "Before", summary: "Old summary", boundingBox: { x: 0, y: 0, width: 100, height: 100 } }] };
  await cache.persistBoard(board);
  const before = await cache.readLatestBoard("abc");
  const abort = new AbortController();
  hooks.afterRename = destination => { if (path.basename(destination).startsWith("refinement-")) abort.abort(); };
  await expect(cache.persistBoard({ ...board, clusters: [{ ...board.clusters[0]!, summary: "Unpublished replacement" }] }, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(await cache.readLatestBoard("abc")).toEqual(before);
  expect(await cache.readCachedBoard("same-logical-key", "abc")).toEqual(before);
  expect(await cache.readBoardSnapshot("abc", before!.snapshotId!)).toEqual(before);
  expect((await readdir(path.join(root, "v4"))).filter(name => name.endsWith(".tmp"))).toEqual([]);
});
