import { mkdtemp } from "node:fs/promises";
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
  });

  it("changes the node hash when extracted text changes", async () => {
    const { hashNormalizedNodes } = await import("../src/lib/persistentCache.js");

    expect(hashNormalizedNodes([node("1:1", "A")])).not.toBe(
      hashNormalizedNodes([node("1:1", "B")]),
    );
  });
});
