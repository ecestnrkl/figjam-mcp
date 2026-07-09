import type { BoardData } from "../types.js";
import { readLatestBoard } from "./persistentCache.js";

/**
 * Simple in-memory store, keyed by boardId. setBoard writes/overwrites an
 * entry produced by ingest_board; getBoard reads it back for
 * get_board_context / answer_from_board. getBoardOrRestore additionally
 * falls back to the persistent cache, so ingested boards survive server
 * restarts without a manual re-ingest.
 */
const boards = new Map<string, BoardData>();

export function setBoard(boardId: string, data: BoardData): void {
  boards.set(boardId, data);
}

export function getBoard(boardId: string): BoardData | undefined {
  return boards.get(boardId);
}

/**
 * Memory-first read with persistent fallback: after a restart the in-memory
 * map is empty, but the last finished ingest is still on disk — load it,
 * mark its cluster summaries as cache-sourced, and re-seed the memory map.
 */
export async function getBoardOrRestore(boardId: string): Promise<BoardData | undefined> {
  const inMemory = boards.get(boardId);
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
  boards.set(boardId, restored);
  return restored;
}
