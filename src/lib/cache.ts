import type { BoardData } from "../types.js";

/**
 * Simple in-memory store, keyed by boardId. setBoard writes/overwrites an
 * entry produced by ingest_board; getBoard reads it back for
 * get_board_context / answer_from_board. Swap for a persistent store
 * (Redis/SQLite/file) once boards need to survive process restarts.
 */
const boards = new Map<string, BoardData>();

export function setBoard(boardId: string, data: BoardData): void {
  boards.set(boardId, data);
}

export function getBoard(boardId: string): BoardData | undefined {
  return boards.get(boardId);
}
