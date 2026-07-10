import type { DiffBoardInput, DiffBoardOutput } from "../schemas/diffBoard.js";
import { diffBoards } from "../lib/boardDiff.js";
import { readBoardHistory, readCachedBoard } from "../lib/persistentCache.js";

/**
 * diff_board — "what changed since the last workshop?".
 *
 * Every ingest_board call records a snapshot in the board's history (one
 * entry per distinct board state). This tool loads the latest snapshot and
 * a baseline (`compareTo` snapshots back, default: the previous one) and
 * diffs them. Typical flow: ingest during workshop 1, ingest again after
 * workshop 2, then diff_board.
 */
export async function diffBoard(input: DiffBoardInput): Promise<DiffBoardOutput> {
  const history = await readBoardHistory(input.boardId);
  if (history.length === 0) {
    throw new Error(
      `No ingest history for board "${input.boardId}" — run ingest_board first (the boardId is the Figma file key).`,
    );
  }

  const stepsBack = input.compareTo ?? 1;
  if (history.length <= stepsBack) {
    throw new Error(
      `Board "${input.boardId}" has only ${history.length} recorded snapshot${history.length === 1 ? "" : "s"} — ` +
        "re-run ingest_board after the board changed, then diff again." +
        (history.length > 1 ? ` (compareTo must be < ${history.length}.)` : ""),
    );
  }

  const currentEntry = history.at(-1)!;
  const baselineEntry = history.at(-1 - stepsBack)!;

  const [baseline, current] = await Promise.all([
    readCachedBoard(baselineEntry.cacheKey),
    readCachedBoard(currentEntry.cacheKey),
  ]);
  if (!baseline || !current) {
    throw new Error(
      `A snapshot of board "${input.boardId}" is no longer cached on disk — re-run ingest_board to record a fresh baseline.`,
    );
  }

  const diff = diffBoards(baseline, current);

  return {
    boardId: input.boardId,
    baselineCreatedAt: new Date(baselineEntry.createdAt).toISOString(),
    currentCreatedAt: new Date(currentEntry.createdAt).toISOString(),
    summaryText: diff.summaryText,
    stats: diff.stats,
    newClusters: diff.newClusters,
    removedClusters: diff.removedClusters,
    modifiedClusters: diff.modifiedClusters,
    addedConnections: diff.addedConnections,
    removedConnections: diff.removedConnections,
  };
}
