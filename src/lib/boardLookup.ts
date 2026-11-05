import { listStoredBoards, listStoredFileKeys } from "./persistentCache.js";

/** Most stored boards named in a message. */
const MAX_LISTED_BOARDS = 10;

const utcMinute = (time: number) => `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * The message for a boardId without stored snapshots: the boards the cache holds (file keys and
 * times only, no board content) and, for a key that differs only in case, the right one. File
 * keys are case-sensitive, so nothing is rewritten silently.
 */
export async function unknownBoardMessage(lead: string, boardId: string): Promise<string> {
  const stored = await listStoredBoards();
  const similar = stored.find((board) => board.fileKey.toLowerCase() === boardId.toLowerCase());
  const listed = stored.slice(0, MAX_LISTED_BOARDS)
    .map((board) => `${board.fileKey} (last ingest ${utcMinute(board.lastIngestAt)})`).join(", ");
  const more = stored.length - MAX_LISTED_BOARDS;
  const keyHint = "boardId is the Figma file key from the board URL (figma.com/board/<key>/…).";
  return [
    similar ? `Did you mean ${similar.fileKey}? File keys are case-sensitive.` : undefined,
    `${lead} ${stored.length
      ? `Stored boards, most recent first: ${listed}${more > 0 ? ` and ${more} more` : ""}. ${keyHint} For another board, run ingest_board first.`
      : `Run ingest_board first. ${keyHint}`}`,
  ].filter(Boolean).join(" ");
}

/**
 * File keys are case-sensitive, but a case-insensitive file system (macOS, Windows) would open the
 * cache of "AbC123" for "abc123". A key that matches a stored one only in case ends the call here,
 * on every system alike, before any cache is read.
 */
export async function assertBoardKeyCase(lead: string, boardId: string): Promise<void> {
  const keys = await listStoredFileKeys();
  if (keys.includes(boardId)) return;
  if (keys.some((key) => key.toLowerCase() === boardId.toLowerCase())) throw new Error(await unknownBoardMessage(lead, boardId));
}
