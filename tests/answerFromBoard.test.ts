import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardData } from "../src/types.js";

const { chatJsonMock, InvalidJsonErrorMock } = vi.hoisted(() => {
  class InvalidJsonErrorMock extends Error {
    constructor(message: string) {
      super(message);
      this.name = "LlmInvalidJsonError";
    }
  }
  return { chatJsonMock: vi.fn(), InvalidJsonErrorMock };
});

vi.mock("../src/lib/llmClient.js", () => ({
  chatJson: chatJsonMock,
  getTextModels: () => ["test-model"],
  LlmInvalidJsonError: InvalidJsonErrorMock,
}));

const { setBoard } = await import("../src/lib/cache.js");
const { answerFromBoard } = await import("../src/tools/answerFromBoard.js");

function board(boardId: string): BoardData {
  return {
    boardId,
    fileKey: boardId,
    docStructureHint: "freeform",
    createdAt: Date.now(),
    nodes: [],
    clusters: [
      {
        id: "cluster_1",
        label: "User research",
        summary: "The project investigates student planning problems and user pain points.",
        confirmedNodeIds: ["1:1"],
        nodeIds: ["1:1"],
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      },
      {
        id: "cluster_2",
        label: "Prototype concept",
        summary: "The team sketches a calendar assistant prototype for semester projects.",
        confirmedNodeIds: ["1:2"],
        nodeIds: ["1:2"],
        boundingBox: { x: 200, y: 0, width: 100, height: 100 },
      },
    ],
  };
}

beforeEach(() => {
  chatJsonMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("answerFromBoard", () => {
  it("uses the model JSON response when it is valid", async () => {
    setBoard("answer-json", board("answer-json"));
    chatJsonMock.mockResolvedValueOnce({
      answer: "It is about planning support for semester projects.",
      citedClusters: ["Prototype concept"],
    });

    await expect(
      answerFromBoard({ boardId: "answer-json", question: "What is the project about?" }),
    ).resolves.toEqual({
      answer: "It is about planning support for semester projects.",
      citedClusters: ["Prototype concept"],
    });
  });

  it("falls back to an extractive answer when the model does not return JSON", async () => {
    setBoard("answer-fallback", board("answer-fallback"));
    chatJsonMock.mockRejectedValueOnce(
      new InvalidJsonErrorMock("LLM did not return valid JSON"),
    );

    const result = await answerFromBoard({
      boardId: "answer-fallback",
      question: "Worum geht es im Projekt?",
    });

    expect(result.answer).toContain("Das Projekt");
    expect(result.answer).toContain("User research");
    expect(result.citedClusters).toEqual(["User research", "Prototype concept"]);
  });

  it("answers the extractive fallback in English for English questions", async () => {
    setBoard("answer-fallback-en", board("answer-fallback-en"));
    chatJsonMock.mockRejectedValueOnce(
      new InvalidJsonErrorMock("LLM did not return valid JSON"),
    );

    const result = await answerFromBoard({
      boardId: "answer-fallback-en",
      // "was" alone must not flip this to German anymore.
      question: "What was the main pain point?",
    });

    expect(result.answer).toContain("Based on the board");
    expect(result.answer).not.toContain("Das Projekt");
  });

  it("passes connector-derived cluster relations to the model", async () => {
    const data = board("answer-relations");
    data.clusterRelations = [
      {
        fromClusterId: "cluster_1",
        toClusterId: "cluster_2",
        labels: ["informs"],
        edgeCount: 2,
      },
    ];
    setBoard("answer-relations", data);
    chatJsonMock.mockResolvedValueOnce({ answer: "ok", citedClusters: [] });

    await answerFromBoard({ boardId: "answer-relations", question: "How do the parts relate?" });

    const messages = chatJsonMock.mock.calls[0]?.[1] as Array<{ role: string; content: string }>;
    const userMessage = messages.find((message) => message.role === "user");
    expect(userMessage?.content).toContain("Connections between clusters");
    expect(userMessage?.content).toContain('"User research" → "Prototype concept" — "informs" (2 connectors)');
  });
});
