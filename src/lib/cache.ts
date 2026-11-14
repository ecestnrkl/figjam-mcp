import type { BoardData } from "../types.js";
import { readIntEnv } from "./env.js";
import { readBoardHead, readLatestBoardState, readBoardSnapshotState, hasLegacyBoard } from "./persistentCache.js";

/**
 * Simple in-memory store, keyed by boardId. setBoard writes/overwrites an
 * entry produced by ingest_board; getBoard reads it back for
 * get_board_context / answer_from_board. getBoardOrRestore additionally
 * falls back to the persistent cache, so ingested boards survive server
 * restarts without a manual re-ingest.
 */
const boards = new Map<string, BoardData>();
const revisions = new WeakMap<BoardData, string | null>();
const readWarnings = new WeakMap<BoardData, string>();

export function getBoardReadWarning(board: BoardData): string | undefined {
  return readWarnings.get(board);
}

export function setBoard(boardId: string, data: BoardData, revisionId?: string | null): void {
  if (revisionId !== undefined) revisions.set(data, revisionId);
  const maxCachedBoards = readIntEnv("FIGJAM_MCP_MEMORY_CACHE_MAX_BOARDS", 10, 1);
  // Map preserves insertion order. Re-inserting an existing board moves it to
  // the most-recently-used end before the oldest entries are evicted.
  boards.delete(boardId);
  boards.set(boardId, data);
  while (boards.size > maxCachedBoards) {
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

export class SnapshotNotInHistoryError extends Error {
  constructor(boardId: string, snapshotId: string, withCursor = false) {
    super(`Snapshot ${snapshotId.slice(0, 12)} of board "${boardId}" is missing from local history. `
      + (snapshotId.length < 64 ? "Use the full snapshot ID to read a specific snapshot. " : "")
      + (withCursor ? "Omit both cursor and snapshotId to read the latest ingest, or run ingest_board."
        : "Omit snapshotId to read the latest ingest, or run ingest_board."));
  }
}

/** Check the published head before serving a mutable latest-board request from memory. */
export async function getBoardOrRestore(boardId: string, snapshotId?: string): Promise<BoardData | undefined> {
  const inMemory = getBoard(boardId);
  if (snapshotId && inMemory?.snapshotId === snapshotId) return inMemory;
  if (!snapshotId && inMemory) {
    const head = await readBoardHead(boardId);
    // Publication order is the revision ID: unchanged ingests retain their source timestamp.
    if (revisions.has(inMemory) && (head.revisionId ?? null) === revisions.get(inMemory)) return inMemory;
    if (!head.damaged && !head.revisionId) return inMemory;
  }

  const state = snapshotId ? await readBoardSnapshotState(boardId, snapshotId) : await readLatestBoardState(boardId);
  const persisted = state.board;
  if (!persisted) {
    if (state.damaged && snapshotId) throw new Error(`The requested snapshot of board "${boardId}" cannot be read (damaged files); run ingest_board to rebuild it.`);
    if (state.damaged) throw new Error(`The cached snapshots of board "${boardId}" cannot be read (damaged files); run ingest_board to rebuild them.`);
    if (snapshotId) throw new SnapshotNotInHistoryError(boardId, snapshotId);
    if (await hasLegacyBoard(boardId)) throw new Error("This board uses cache v3. Run ingest_board again to capture complete sources for cache v4; old files are preserved.");
    return undefined;
  }

  const restored: BoardData = {
    ...persisted,
    clusters: persisted.clusters.map((cluster) => ({ ...cluster, cacheHit: true })),
  };
  if (state.warning) readWarnings.set(restored, state.warning);
  if (!snapshotId) setBoard(boardId, restored, state.revisionId);
  return restored;
}
