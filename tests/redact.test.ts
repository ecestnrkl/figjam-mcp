import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceBoard, textNode } from "./fixtures/retrieval.js";
import { flattenNodeTree } from "../src/lib/nodeTree.js";
import { redactBoard, redactCredentials } from "../src/lib/redact.js";

const { chatJsonMock } = vi.hoisted(() => ({ chatJsonMock: vi.fn() }));
vi.mock("../src/lib/llmClient.js", () => ({
  chatJson: chatJsonMock, getAnswerReasoningEffort: () => undefined, getTextModels: () => ["test-model"],
  LlmInvalidJsonError: class extends Error {},
}));
const { setBoard } = await import("../src/lib/cache.js");
const { answerFromBoard } = await import("../src/tools/answerFromBoard.js");
const { getBoardContext } = await import("../src/tools/getBoardContext.js");

// Synthetic values, assembled at runtime so secret scanners do not flag the test file.
const githubToken = "ghp_" + "A1b2C3d4".repeat(4) + "e5F6";
const githubPat = "github_pat_" + "11ABCDEFG0".repeat(3) + "_xyz";
const openAiKey = "sk-" + "proj-" + "a1B2c3D4e5".repeat(3);
const openRouterKey = "sk-" + "or-v1-" + "0123456789abcdef".repeat(4);
const figmaToken = "figd_" + "Zx9_Yw8-Vu7".repeat(3);
const awsKey = "AKIA" + "IOSFODNN7EXAMPLE";
const slackToken = "xox" + "b-123456789012-" + "abcdefABCDEF1234";
const pemBlock = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEAsynthetic", "c3ludGhldGljIGtleQ==", "-----END RSA PRIVATE KEY-----"].join("\n");

beforeEach(() => { chatJsonMock.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("redactCredentials", () => {
  it.each([
    ["Passwort: Sommer2024!", "Passwort: [redacted]"],
    ["WLAN-Passwort = hunter2 bitte nicht teilen", "WLAN-Passwort = [redacted]"],
    ["Kennwort:geheim", "Kennwort:[redacted]"],
    ["password: correct horse battery staple", "password: [redacted]"],
    ["PASSCODE: 4711", "PASSCODE: [redacted]"],
    ["PW: abc123", "PW: [redacted]"],
    ["pwd=abc123", "pwd=[redacted]"],
    ["PIN: 1234", "PIN: [redacted]"],
    ["API key: abc-def", "API key: [redacted]"],
    ["api-key: abc-def", "api-key: [redacted]"],
    ["APIKEY=abc-def", "APIKEY=[redacted]"],
    ["API Token: t0ken", "API Token: [redacted]"],
    ["Access token: t0ken", "Access token: [redacted]"],
    ["auth_token=t0ken", "auth_token=[redacted]"],
    ["Bearer Token: t0ken", "Bearer Token: [redacted]"],
    ["Client Secret: s3cret", "Client Secret: [redacted]"],
    ["Secret key = s3cret", "Secret key = [redacted]"],
    ["Access Key: s3cret", "Access Key: [redacted]"],
    ["Private key: s3cret", "Private key: [redacted]"],
  ])("redacts the labelled value in %j", (input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  it("redacts only to the end of the line", () => {
    expect(redactCredentials("Login für das Testsystem\nPasswort: Sommer2024!\nNächster Schritt: Demo"))
      .toBe("Login für das Testsystem\nPasswort: [redacted]\nNächster Schritt: Demo");
  });

  it.each([
    ["GitHub token", githubToken],
    ["GitHub fine-grained token", githubPat],
    ["OpenAI key", openAiKey],
    ["OpenRouter key", openRouterKey],
    ["Figma token", figmaToken],
    ["AWS access key", awsKey],
    ["Slack token", slackToken],
  ])("redacts a %s anywhere in the text", (_name, secret) => {
    const output = redactCredentials(`Use ${secret} for the demo`);
    expect(output).toBe("Use [redacted] for the demo");
  });

  it("redacts private key blocks", () => {
    expect(redactCredentials(`Server key:\n${pemBlock}\nDone`)).toBe("Server key:\n[redacted]\nDone");
  });

  it.each([
    "PIN-Code klären",
    "Passwort vergessen?",
    "Token: color-primary",
    "Secret: launch plan stays internal",
    "Password reset flow needs a review",
    "Spin: 360°",
    "Passwort:",
    "Risk-assessment for sk-tier customers",
  ])("keeps mentions without a value: %j", (input) => {
    expect(redactCredentials(input)).toBe(input);
  });

  it("is idempotent", () => {
    const input = `Passwort: hunter2\nKey ${githubToken}\n${pemBlock}\nAPI key = ${openAiKey}`;
    const once = redactCredentials(input);
    expect(once).not.toContain("hunter2");
    expect(redactCredentials(once)).toBe(once);
  });

  it("can be switched off with FIGJAM_MCP_REDACT_CREDENTIALS=false", () => {
    vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "false");
    expect(redactCredentials("Passwort: hunter2")).toBe("Passwort: hunter2");
    const board = evidenceBoard("RedactOff123", [textNode("1:1", "Passwort: hunter2")]);
    expect(redactBoard(board)).toBe(board);
  });
});

describe("credential redaction during extraction", () => {
  const file = {
    document: {
      id: "0:0", name: "Document", type: "DOCUMENT",
      children: [{
        id: "0:1", name: "Page 1", type: "CANVAS",
        children: [
          {
            id: "1:1", name: "Passwort: Sommer2024!", type: "TEXT", characters: "Passwort: Sommer2024!",
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
          },
          {
            id: "1:2", name: "Table", type: "TABLE", absoluteBoundingBox: { x: 200, y: 0, width: 300, height: 100 },
            children: [
              { id: "1:3", name: "Cell", type: "TABLE_CELL", rowIndex: 0, columnIndex: 0, characters: "Admin PIN" },
              { id: "1:4", name: "Cell", type: "TABLE_CELL", rowIndex: 0, columnIndex: 1, characters: `API key: ${openAiKey}` },
            ],
          },
        ],
      }],
    },
  };

  it("redacts node names, text and table cells", () => {
    const nodes = flattenNodeTree(file);
    const serialized = JSON.stringify(nodes);
    expect(serialized).not.toContain("Sommer2024");
    expect(serialized).not.toContain(openAiKey);
    const text = nodes.find((node) => node.id === "1:1")!;
    expect(text).toMatchObject({ name: "Passwort: [redacted]", text: "Passwort: [redacted]" });
    const table = nodes.find((node) => node.id === "1:2")!;
    expect(table.table?.cells.map((cell) => cell.text)).toEqual(["Admin PIN", "API key: [redacted]"]);
    expect(table.text).toBe("Admin PIN\nAPI key: [redacted]");
  });

  it("keeps values when redaction is switched off", () => {
    vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "false");
    expect(JSON.stringify(flattenNodeTree(file))).toContain("Sommer2024");
  });
});

describe("snapshots cached before redaction", () => {
  function legacyBoard(boardId: string) {
    const board = evidenceBoard(boardId, [
      { ...textNode("1:1", "Login für das Testsystem\nPasswort: Sommer2024!"), name: "Passwort: Sommer2024!" },
      { ...textNode("1:2", ""), type: "TABLE", table: { cells: [{ id: "c1", text: `Client Secret: ${figmaToken}`, row: 0, column: 0 }] } },
    ]);
    board.extractionVersion = 5;
    board.clusters[0]!.summary = "The sticky lists Passwort: Sommer2024! for the test system.";
    board.clusters[0]!.summarySource = "vision_llm";
    board.connectorEdges = [{ connectorId: "2:1", fromNodeId: "1:1", toNodeId: "1:2", direction: "forward", label: "PIN: 9876" }];
    return board;
  }

  it("never puts an unredacted value into get_board_context output", async () => {
    setBoard("LegacyContext123", legacyBoard("LegacyContext123"));
    const output = await getBoardContext({ boardId: "LegacyContext123" });
    const serialized = JSON.stringify(output);
    expect(output.text).toContain("Passwort: [redacted]");
    expect(output.text).toContain("Client Secret: [redacted]");
    expect(output.text).toContain("(PIN: [redacted])");
    for (const secret of ["Sommer2024", figmaToken, "9876"]) expect(serialized).not.toContain(secret);
  });

  it("never sends an unredacted value to the provider", async () => {
    setBoard("LegacyAnswer123", legacyBoard("LegacyAnswer123"));
    chatJsonMock.mockResolvedValueOnce({ kind: "unsupported", language: "de", answer: "", evidenceIds: [] });
    const output = await answerFromBoard({ boardId: "LegacyAnswer123", question: "Wie lautet das Passwort für das Testsystem?" });
    const prompt = JSON.stringify(chatJsonMock.mock.calls[0]?.[1]);
    expect(prompt).toContain("Passwort: [redacted]");
    expect(prompt).toContain("(PIN: [redacted])");
    for (const secret of ["Sommer2024", figmaToken, "9876"]) {
      expect(prompt).not.toContain(secret);
      expect(JSON.stringify(output)).not.toContain(secret);
    }
  });
});
