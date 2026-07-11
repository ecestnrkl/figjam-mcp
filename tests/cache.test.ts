import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardData } from "../src/types.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

function board(boardId: string): BoardData {
  return {
    boardId,
    fileKey: boardId,
    docStructureHint: "freeform",
    nodes: [],
    clusters: [],
    createdAt: 1,
  };
}

describe("in-memory board cache", () => {
  it("evicts the least recently used board at the configured limit", async () => {
    process.env.FIGJAM_MCP_MEMORY_CACHE_MAX_BOARDS = "2";
    const { getBoard, setBoard } = await import("../src/lib/cache.js");

    setBoard("a", board("a"));
    setBoard("b", board("b"));

    // Reading a makes b the least-recently-used entry.
    expect(getBoard("a")?.boardId).toBe("a");
    setBoard("c", board("c"));

    expect(getBoard("a")?.boardId).toBe("a");
    expect(getBoard("b")).toBeUndefined();
    expect(getBoard("c")?.boardId).toBe("c");
  });
});
