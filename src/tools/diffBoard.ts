import type { DiffBoardInput, DiffBoardOutput } from "../schemas/diffBoard.js";
import { diffBoards } from "../lib/boardDiff.js";
import { readBoardHistory, readCachedBoard } from "../lib/persistentCache.js";
import { redactBoard } from "../lib/redact.js";

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
  const currentEntry = history.at(-1)!;
  // Re-ingesting identical content keeps one snapshot but records a fresh check.
  const singleSnapshot = history.length === 1 && stepsBack === 1
    ? await readCachedBoard(currentEntry.refinementId ?? currentEntry.cacheKey)
    : undefined;
  const unchanged = singleSnapshot?.freshnessCheckedAt !== undefined && singleSnapshot.freshnessCheckedAt > currentEntry.createdAt;
  if (history.length <= stepsBack && !unchanged) {
    throw new Error(
      `Board "${input.boardId}" has only ${history.length} recorded snapshot${history.length === 1 ? "" : "s"} — ` +
        "re-run ingest_board after the board changed, then diff again." +
        (history.length > 1 ? ` (compareTo must be < ${history.length}.)` : ""),
    );
  }

  const baselineEntry = unchanged ? currentEntry : history.at(-1 - stepsBack)!;

  const [baseline, current] = await Promise.all([
    singleSnapshot ?? readCachedBoard(baselineEntry.refinementId ?? baselineEntry.cacheKey),
    singleSnapshot ?? readCachedBoard(currentEntry.refinementId ?? currentEntry.cacheKey),
  ]);
  if (!baseline || !current) {
    throw new Error(
      `A snapshot of board "${input.boardId}" is no longer cached on disk — re-run ingest_board to record a fresh baseline.`,
    );
  }

  // A baseline cached before redaction existed must not leak through the diff.
  const diff = diffBoards(redactBoard(baseline), redactBoard(current));

  return {
    boardId: input.boardId,
    baselineSnapshotId: baseline.snapshotId,
    currentSnapshotId: current.snapshotId,
    baselineCreatedAt: new Date(baselineEntry.createdAt).toISOString(),
    currentCreatedAt: new Date(currentEntry.createdAt).toISOString(),
    summaryText: unchanged
      ? `No changes: the board content is the same as at ${new Date(currentEntry.createdAt).toISOString()}; ` +
        `the last ingest at ${new Date(singleSnapshot!.freshnessCheckedAt!).toISOString()} found it unchanged.`
      : diff.summaryText,
    stats: unchanged ? { ...diff.stats, unchangedClusters: 0 } : diff.stats,
    newClusters: diff.newClusters,
    removedClusters: diff.removedClusters,
    modifiedClusters: diff.modifiedClusters,
    addedConnections: diff.addedConnections,
    removedConnections: diff.removedConnections,
    tableCellChanges: diff.tableCellChanges,
    nodeChanges: diff.nodeChanges,
    ...(diff.nodeChangesOmitted === undefined ? {} : { nodeChangesOmitted: diff.nodeChangesOmitted }),
  };
}
