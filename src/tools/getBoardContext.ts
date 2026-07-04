import type {
  GetBoardContextInput,
  GetBoardContextOutput,
} from "../schemas/getBoardContext.js";

/**
 * Mock handler for get_board_context. Returns plausible placeholder data
 * shaped exactly like GetBoardContextOutput — no real board lookup yet.
 */
export async function getBoardContext(
  input: GetBoardContextInput,
): Promise<GetBoardContextOutput> {
  const topicSuffix = input.topic ? ` (topic: "${input.topic}")` : "";

  return {
    contextText:
      `Mock context for board "${input.boardId}"${topicSuffix}. ` +
      `This board has 4 placeholder clusters spanning discovery notes, ` +
      `problem framing, ideation sketches, and next steps.`,
    clusters: [
      {
        label: "Problem framing",
        phase: "define",
        summary: "Sticky notes outlining the core user problem and constraints.",
        sourceNodeIds: ["1:23", "1:24", "1:25"],
      },
      {
        label: "Ideation sketches",
        phase: "develop",
        summary: "Rough sketches and arrows exploring possible solutions.",
        sourceNodeIds: ["2:10", "2:11"],
      },
      {
        label: "User research notes",
        phase: "discover",
        summary: "Quotes and observations gathered from user interviews.",
        sourceNodeIds: ["3:5", "3:6", "3:7"],
      },
      {
        label: "Next steps",
        phase: "deliver",
        summary: "Action items and owners agreed on at the end of the session.",
        sourceNodeIds: ["4:1"],
      },
    ],
  };
}
