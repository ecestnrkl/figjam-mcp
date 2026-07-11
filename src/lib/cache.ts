import type { BoardData } from "../types.js";
import { readIntEnv } from "./env.js";
import { readLatestBoard } from "./persistentCache.js";

/**
 * Simple in-memory store, keyed by boardId. setBoard writes/overwrites an
 * entry produced by ingest_board; getBoard reads it back for
 * get_board_context / answer_from_board. getBoardOrRestore additionally
 * falls back to the persistent cache, so ingested boards survive server
 * restarts without a manual re-ingest.
 */
const MAX_CACHED_BOARDS = readIntEnv("FIGJAM_MCP_MEMORY_CACHE_MAX_BOARDS", 10, 1);
const boards = new Map<string, BoardData>();

export function setBoard(boardId: string, data: BoardData): void {
  // Map preserves insertion order. Re-inserting an existing board moves it to
  // the most-recently-used end before the oldest entries are evicted.
  boards.delete(boardId);
  boards.set(boardId, data);
  while (boards.size > MAX_CACHED_BOARDS) {
    const oldestBoardId = boards.keys().next().value as string | undefined;
    if (oldestBoardId === undefined) {
      break;
    }
    boards.delete(oldestBoardId);
  }
}

export function getBoard(boardId: string): BoardData | undefined {
  const board = boards.get(boardId);
  if (!board) {
    return undefined;
  }

  boards.delete(boardId);
  boards.set(boardId, board);
  return board;
}

/**
 * Memory-first read with persistent fallback: after a restart the in-memory
 * map is empty, but the last finished ingest is still on disk — load it,
 * mark its cluster summaries as cache-sourced, and re-seed the memory map.
 */
export async function getBoardOrRestore(boardId: string): Promise<BoardData | undefined> {
  const inMemory = getBoard(boardId);
  if (inMemory) {
    return inMemory;
  }

  const persisted = await readLatestBoard(boardId);
  if (!persisted) {
    return undefined;
  }

  const restored: BoardData = {
    ...persisted,
    clusters: persisted.clusters.map((cluster) => ({
      ...cluster,
      summarySource: "cache" as const,
    })),
    createdAt: Date.now(),
  };
  setBoard(boardId, restored);
  return restored;
}
