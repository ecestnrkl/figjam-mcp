import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceBoard, textNode } from "./fixtures/retrieval.js";

const { chatJsonMock } = vi.hoisted(() => ({ chatJsonMock: vi.fn() }));
vi.mock("../src/lib/llmClient.js", () => ({
  chatJson: chatJsonMock, getAnswerReasoningEffort: () => undefined,
  getTextModels: () => ["test-model"], LlmInvalidJsonError: class extends Error {},
}));
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("LLM_ANSWER_TOP_K", "");
  vi.stubEnv("LLM_ANSWER_PROMPT_MAX_CHARS", "");
  chatJsonMock.mockReset().mockResolvedValue({ kind: "unsupported" });
});
afterEach(() => vi.unstubAllEnvs());

async function ask(text = "Payment procedure") {
  const { setBoard } = await import("../src/lib/cache.js");
  const { answerFromBoard } = await import("../src/tools/answerFromBoard.js");
  const board = evidenceBoard("AnswerConfig", Array.from({ length: 35 }, (_, i) =>
    ({ ...textNode(`n:${i}`, text), sectionIds: [] })));
  setBoard(board.boardId, board);
  const output = await answerFromBoard({ boardId: board.boardId, question: "Payment approval?" });
  const messages = chatJsonMock.mock.calls[0]![1] as Array<{ content: string }>;
  const count = messages.at(-1)!.content.match(/\[(ev_[a-f0-9]+)\]/g)!.length;
  return { output, messages, count };
}

describe("answer retrieval configuration", () => {
  it.each([["", 15], ["1", 1], ["30", 30], ["99", 30]])("TOP_K=%s selects %i primary excerpts", async (value, expected) => {
    vi.stubEnv("LLM_ANSWER_TOP_K", value);
    const { count, output } = await ask();
    expect(count).toBe(expected);
    expect(output.answer).toContain(`The ${count} best-matching excerpts`);
  });

  it.each([["", 40000], ["4096", 4096], ["60000", 60000], ["99999", 60000]])("PROMPT_MAX_CHARS=%s bounds the entire prompt at %i", async (value, expected) => {
    vi.stubEnv("LLM_ANSWER_TOP_K", "30");
    vi.stubEnv("LLM_ANSWER_PROMPT_MAX_CHARS", value);
    // Escaping expands each source well beyond its raw-text chunk size.
    const { messages, count, output } = await ask("Payment " + "& ".repeat(590));
    const length = messages.reduce((sum, message) => sum + message.content.length, 0);
    expect(length).toBeLessThanOrEqual(expected);
    expect(length).toBeGreaterThan(expected * 0.8);
    expect(output.answer).toContain(`The ${count} best-matching excerpts`);
    expect(output.citations).toEqual([]);
    if (expected === 4096) expect(count).toBeLessThan(30);
  });

  it("preserves fifteen full long excerpts with the default prompt budget", async () => {
    const text = "Payment " + "factual detail ".repeat(79);
    const { messages, count } = await ask(text);
    expect(count).toBe(15);
    expect(messages.at(-1)!.content.split(text.trim())).toHaveLength(16);
  });

  it.each([
    ["LLM_ANSWER_TOP_K", "0", 1], ["LLM_ANSWER_TOP_K", "1.5", 1],
    ["LLM_ANSWER_PROMPT_MAX_CHARS", "4095", 4096], ["LLM_ANSWER_PROMPT_MAX_CHARS", "invalid", 4096],
  ])("rejects %s=%s below the minimum or not an integer", async (name, value, minimum) => {
    vi.stubEnv(name, value);
    await expect(import("../src/tools/answerFromBoard.js")).rejects.toThrow(`${name} must be an integer >= ${minimum}`);
    expect(chatJsonMock).not.toHaveBeenCalled();
  });
});
