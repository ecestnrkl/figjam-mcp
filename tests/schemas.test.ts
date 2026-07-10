import { describe, expect, it } from "vitest";
import { answerFromBoardInputSchema } from "../src/schemas/answerFromBoard.js";
import { diffBoardInputSchema } from "../src/schemas/diffBoard.js";
import { getBoardContextInputSchema } from "../src/schemas/getBoardContext.js";
import { ingestBoardInputSchema } from "../src/schemas/ingestBoard.js";

const FILE_KEY = "AbC123XyZ456";
const FIGMA_URL = `https://www.figma.com/board/${FILE_KEY}/Project-Board`;

describe("shared input validation", () => {
  it("trims valid board IDs, questions, and topics", () => {
    expect(
      answerFromBoardInputSchema.parse({
        boardId: `  ${FILE_KEY}  `,
        question: "  What are the main findings?  ",
      }),
    ).toEqual({ boardId: FILE_KEY, question: "What are the main findings?" });

    expect(
      getBoardContextInputSchema.parse({
        boardId: ` ${FILE_KEY} `,
        topic: "  user research  ",
      }),
    ).toEqual({ boardId: FILE_KEY, topic: "user research" });
  });

  it("rejects malformed or unreasonably sized board IDs", () => {
    for (const boardId of ["short", "abc-def", "abc/def", "a".repeat(129)]) {
      expect(diffBoardInputSchema.safeParse({ boardId }).success).toBe(false);
    }
    expect(diffBoardInputSchema.safeParse({ boardId: "AbC123" }).success).toBe(true);
  });

  it("rejects empty and overlong questions or topics", () => {
    expect(
      answerFromBoardInputSchema.safeParse({ boardId: FILE_KEY, question: "   " }).success,
    ).toBe(false);
    expect(
      answerFromBoardInputSchema.safeParse({
        boardId: FILE_KEY,
        question: "q".repeat(2001),
      }).success,
    ).toBe(false);
    expect(
      getBoardContextInputSchema.safeParse({ boardId: FILE_KEY, topic: "\n\t" }).success,
    ).toBe(false);
    expect(
      getBoardContextInputSchema.safeParse({
        boardId: FILE_KEY,
        topic: "t".repeat(201),
      }).success,
    ).toBe(false);
  });
});

describe("ingest_board input validation", () => {
  it.each(["file", "design", "board", "proto"])(
    "accepts and trims a canonical %s URL",
    (documentType) => {
      const input = ingestBoardInputSchema.parse({
        figmaFileUrl: `  https://www.figma.com/${documentType}/${FILE_KEY}/Project?node-id=1-2  `,
      });

      expect(input.figmaFileUrl).toBe(
        `https://www.figma.com/${documentType}/${FILE_KEY}/Project?node-id=1-2`,
      );
    },
  );

  it("accepts figma.com and genuine Figma subdomains", () => {
    expect(
      ingestBoardInputSchema.safeParse({
        figmaFileUrl: `https://figma.com/board/${FILE_KEY}`,
      }).success,
    ).toBe(true);
    expect(
      ingestBoardInputSchema.safeParse({
        figmaFileUrl: `https://enterprise.figma.com/design/${FILE_KEY}/Project`,
      }).success,
    ).toBe(true);
  });

  it.each([
    [`https://example.com/path/figma.com/board/${FILE_KEY}/Project`, "foreign host in path"],
    [`https://evilfigma.com/board/${FILE_KEY}/Project`, "lookalike host"],
    [`https://figma.com.evil.example/board/${FILE_KEY}/Project`, "host suffix attack"],
    [`http://www.figma.com/board/${FILE_KEY}/Project`, "HTTP"],
    [`https://www.figma.com:8443/board/${FILE_KEY}/Project`, "custom port"],
    [`https://user:password@www.figma.com/board/${FILE_KEY}/Project`, "credentials"],
    [`https://www.figma.com/community/file/${FILE_KEY}/Project`, "wrong path prefix"],
    [`https://www.figma.com/board/${FILE_KEY}/Project/extra`, "extra path segment"],
    ["https://www.figma.com/board/short/Project", "short file key"],
    [`https://www.figma.com/board/AbC-123/Project`, "punctuated file key"],
  ])("rejects %s (%s)", (figmaFileUrl) => {
    expect(ingestBoardInputSchema.safeParse({ figmaFileUrl }).success).toBe(false);
  });

  it("trims tokens and custom phases", () => {
    const input = ingestBoardInputSchema.parse({
      figmaFileUrl: FIGMA_URL,
      figmaAccessToken: "  figd_example-token  ",
      customPhases: ["  Research  ", "Synthesis "],
    });

    expect(input.figmaAccessToken).toBe("figd_example-token");
    expect(input.customPhases).toEqual(["Research", "Synthesis"]);
  });

  it("rejects whitespace-only, empty, overlong, and case-insensitively duplicate phases", () => {
    for (const customPhases of [
      [],
      ["   "],
      ["x".repeat(81)],
      ["Research", " research "],
      ["ＰＨＡＳＥ", "phase"],
    ]) {
      expect(
        ingestBoardInputSchema.safeParse({ figmaFileUrl: FIGMA_URL, customPhases }).success,
      ).toBe(false);
    }
  });

  it("rejects an explicitly blank Figma token", () => {
    expect(
      ingestBoardInputSchema.safeParse({
        figmaFileUrl: FIGMA_URL,
        figmaAccessToken: "   ",
      }).success,
    ).toBe(false);
  });
});
