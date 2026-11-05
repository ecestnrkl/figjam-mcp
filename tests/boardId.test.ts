import { describe, expect, it } from "vitest";
import { parseBoardId, parseFigmaUrl } from "../src/schemas/common.js";

const link = (query: string, key = "AbC123", kind = "board") => `https://www.figma.com/${kind}/${key}/Example?${query}`;

describe("boardId as key or URL", () => {
  it.each([
    ["AbC123", { fileKey: "AbC123" }],
    ["  AbC123  ", { fileKey: "AbC123" }],
    [link(""), { fileKey: "AbC123" }],
    [link("node-id=5-87&t=abc"), { fileKey: "AbC123", nodeId: "5-87" }],
    [link("node-id=5%3A87", "AbC123", "design"), { fileKey: "AbC123", nodeId: "5:87" }],
    ["https://www.figma.com/board/AbC123", { fileKey: "AbC123" }],
  ])("reads %s", (value, expected) => expect(parseBoardId(value)).toEqual(expected));

  it.each(["not a key!", "abc-def", "http://www.figma.com/board/AbC123/Example", "https://example.com/board/AbC123/Example",
    "https://www.figma.com/files/recent", "a".repeat(129)])("does not read %s", (value) => {
    expect(parseBoardId(value)).toBeUndefined();
    expect(parseFigmaUrl(value)).toBeUndefined();
  });
});
