import { randomUUID } from "node:crypto";
import type { IngestBoardInput, IngestBoardOutput } from "../schemas/ingestBoard.js";

/**
 * Mock handler for ingest_board. Returns plausible placeholder data shaped
 * exactly like IngestBoardOutput — no real Figma fetching/clustering yet.
 */
export async function ingestBoard(input: IngestBoardInput): Promise<IngestBoardOutput> {
  const boardId = `board_${randomUUID()}`;

  return {
    boardId,
    clusterCount: 4,
    summary:
      `Mock ingest of "${input.figmaFileUrl}" using docStructureHint=` +
      `"${input.docStructureHint}". Found 4 placeholder clusters ` +
      `(real ingestion pipeline not implemented yet).`,
  };
}
