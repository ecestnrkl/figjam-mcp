import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceBoard, textNode } from "./fixtures/retrieval.js";
import { flattenNodeTree } from "../src/lib/nodeTree.js";
import { hasProtectedTableValue, redactBoard, redactCredentials, redactMessageCredentials, redactTableCells } from "../src/lib/redact.js";

const { chatJsonMock, readBoardHistoryMock, readCachedBoardMock } = vi.hoisted(() => ({
  chatJsonMock: vi.fn(), readBoardHistoryMock: vi.fn(), readCachedBoardMock: vi.fn(),
}));
vi.mock("../src/lib/persistentCache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/persistentCache.js")>()),
  readBoardHistory: readBoardHistoryMock, readCachedBoard: readCachedBoardMock,
  readBoardHead: async () => ({ damaged: false }), listStoredFileKeys: async () => [],
}));
vi.mock("../src/lib/llmClient.js", () => ({
  chatJson: chatJsonMock, getAnswerReasoningEffort: () => undefined, getTextModels: () => ["test-model"],
  LlmInvalidJsonError: class extends Error {},
}));
const { setBoard } = await import("../src/lib/cache.js");
const { answerFromBoard } = await import("../src/tools/answerFromBoard.js");
const { getBoardContext } = await import("../src/tools/getBoardContext.js");
const { diffBoard } = await import("../src/tools/diffBoard.js");

// Synthetic values, assembled at runtime so secret scanners do not flag the test file.
const githubToken = "ghp_" + "A1b2C3d4".repeat(4) + "e5F6";
const githubPat = "github_pat_" + "11ABCDEFG0".repeat(3) + "_xyz";
const openAiKey = "sk-" + "proj-" + "a1B2c3D4e5".repeat(3);
const openRouterKey = "sk-" + "or-v1-" + "0123456789abcdef".repeat(4);
const figmaToken = "figd_" + "Zx9_Yw8-Vu7".repeat(3);
const awsKey = "AKIA" + "IOSFODNN7EXAMPLE";
const slackToken = "xox" + "b-123456789012-" + "abcdefABCDEF1234";
const pemBlock = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEAsynthetic", "c3ludGhldGljIGtleQ==", "-----END RSA PRIVATE KEY-----"].join("\n");

const extendedCredentialCases = [
  ["Admin password for the test devices: Summer2026!", "Admin password for the test devices: [redacted]"],
  ["Passwort für das Testgerät: Sommer2026!", "Passwort für das Testgerät: [redacted]"],
  ["Kennwort zum Testsystem = Winter2027?", "Kennwort zum Testsystem = [redacted]"],
  ["Passcode zur Anmeldung: 8812", "Passcode zur Anmeldung: [redacted]"],
  ["API key of the demo: demo-key", "API key of the demo: [redacted]"],
  ["Access token von Lea: demo-token", "Access token von Lea: [redacted]"],
  ["Auth token for tests: demo-token", "Auth token for tests: [redacted]"],
  ["Bearer token for tests: demo-token", "Bearer token for tests: [redacted]"],
  ["Client secret for tests: demo-secret", "Client secret for tests: [redacted]"],
  ["Secret key for tests: demo-key", "Secret key for tests: [redacted]"],
  ["Access key for tests: demo-key", "Access key for tests: [redacted]"],
  ["Private key for tests: demo-key", "Private key for tests: [redacted]"],
  ["Passwort (Test-iPad): Sommer2026!", "Passwort (Test-iPad): [redacted]"],
  ["API key (demo) = demo-key", "API key (demo) = [redacted]"],
  ["Passwort:\nSommer2026!", "Passwort:\n[redacted]"],
  ["Client secret =\r\n\r\n  demo-secret  \r\nDone", "Client secret =\r\n\r\n  [redacted]  \r\nDone"],
  ["PIN:\n4711", "PIN:\n[redacted]"],
  ["PIN-Code:\ncodeword", "PIN-Code:\n[redacted]"],
  ["aws_secret_access_key = wJalrSyntheticValue", "aws_secret_access_key = [redacted]"],
  ["PIN-Code: 4711", "PIN-Code: [redacted]"],
  ["PIN Code: letters are permitted", "PIN Code: [redacted]"],
  ["Zugangscode: 8812", "Zugangscode: [redacted]"],
  ["Zugangscode: guest entry code", "Zugangscode: [redacted]"],
  ["Pin: 4-word test code", "Pin: [redacted]"],
  ["Authorization: Bearer " + "aB_1-".repeat(4), "Authorization: Bearer [redacted]"],
  ["Use Bearer " + "aB_1-".repeat(4) + " here", "Use Bearer [redacted] here"],
  ["Session " + ["eyJhbGciOiJIUzI1NiJ9", "c3ludGhldGlj", "c2lnbmF0dXJl"].join(".") + " expires", "Session [redacted] expires"],
] as const;

const unchangedCredentialCases = [
  "Design tokens: color.primary", "Token: color-primary-500", "PIN board for ideas",
  "Pin the following ideas: first, second", "Pin: Feature X to the top", "PIN: letters",
  "Passwort-Reset: Link per Mail", "Password reset: send link",
  "Password policy:\n- at least 12 characters", "Secret sauce: speed",
  "PIN for the demo: 4711", "PW for the demo: abc123", "pwd (demo): abc123",
  "Passwort:\nabc", "Passwort:\ncorrect horse battery staple", "PIN:\nletter-code",
  "Password for " + "x".repeat(41) + ": demo-secret",
  "Use Bearer " + "a".repeat(19), "Use eyJabc.one only", "Use abc.one.two here",
] as const;

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
    ["API\tkey=abc-def", "API\tkey=[redacted]"],
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

  it.each(extendedCredentialCases)("redacts the narrowly extended case %j", (input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
    const raw = { document: { id: "root", name: "Document", type: "DOCUMENT", children: [
      { id: "text", name: input, type: "TEXT", characters: input },
    ] } };
    expect(flattenNodeTree(raw).find((node) => node.id === "text")).toMatchObject({ name: expected, text: expected });
    const board = evidenceBoard("SyntheticLegacy", [{ ...textNode("text", input), name: input }]);
    expect(redactBoard(board).nodes[0]).toMatchObject({ name: expected, text: expected });
  });

  it.each(unchangedCredentialCases)("preserves the non-credential case %j", (input) => {
    expect(redactCredentials(input)).toBe(input);
  });

  it("allows at most 40 suffix characters after a recognized preposition", () => {
    expect(redactCredentials("Password for " + "x".repeat(40) + ": demo-secret"))
      .toBe("Password for " + "x".repeat(40) + ": [redacted]");
  });

  it("keeps quotes, later highlights and the final sentence after an existing marker (CD11)", () => {
    const summary = 'Extracted text highlights: "Guest Wi-Fi password: [redacted]"; "Plan the workshop". The board contains two groups.';
    expect(redactCredentials(summary)).toBe(summary);
    expect(redactCredentials('Passwort:\n[redacted]";')).toBe('Passwort:\n[redacted]";');
    const board = evidenceBoard("SyntheticSummary", [textNode("text", "Guest Wi-Fi password: [redacted]")]);
    board.clusters[0]!.summary = summary;
    expect(redactBoard(board).clusters[0]!.summary).toBe(summary);
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

describe("credential table context", () => {
  const tableLabels = ["Password", "Passwort:", "Kennwort", "Passcode", "PW", "pwd", "PIN", "PIN-Code", "PIN Code", "Zugangscode",
    "API key", "API token", "Access token", "Auth token", "Bearer token", "Client secret", "Secret key", "Access key", "Private key"];
  const makeCells = (rows: string[][]) => rows.flatMap((row, rowIndex) => row.map((text, column) => ({
    id: `cell-${rowIndex}-${column}`, row: rowIndex, column, text,
  })));

  it.each([
    { name: "label without a value row", rows: [["Password"]], protected: false },
    { name: "label over an empty cell", rows: [["Password"], [""]], protected: false },
    { name: "value in column zero", rows: [["Password"], ["synthetic-value"]], protected: true },
    { name: "key/value row", rows: [["Feature", "Value"], ["Password", "synthetic-value"]], protected: true },
    { name: "already masked value", rows: [["Password"], ["[redacted]"]], protected: true },
    { name: "ordinary table", rows: [["Feature", "Value"], ["Login", "Improved"]], protected: false },
  ])("detects protected table values: $name", ({ rows, protected: expected }) => {
    const cells = makeCells(rows);
    const node = { ...textNode("table", ""), type: "TABLE", table: { cells } };
    expect(hasProtectedTableValue([node])).toBe(expected);
    const masked = redactTableCells(cells);
    expect(hasProtectedTableValue([{ ...node, table: { cells: masked } }])).toBe(expected);
    expect(redactTableCells(masked)).toEqual(masked);
    if (!expected) expect(masked).toEqual(cells);
  });

  it("leaves an empty credential cell empty through extraction", () => {
    const table = flattenNodeTree({ document: { id: "root", name: "Document", type: "DOCUMENT", children: [{
      id: "table", name: "Table", type: "TABLE", children: makeCells([["Password"], [""]]).map((cell) => ({
        id: cell.id, name: "Cell", type: "TABLE_CELL", characters: cell.text, rowIndex: cell.row, columnIndex: cell.column,
      })),
    }] } }).find((node) => node.id === "table")!;
    expect(table.table?.cells.map((cell) => cell.text)).toEqual(["Password", ""]);
    expect(hasProtectedTableValue([table])).toBe(false);
  });

  it.each(tableLabels)("redacts the full protected column under an exact %s header, including mixed case", (label) => {
    const cells = makeCells([["Portal", "User", label.toUpperCase()], ["Admin-Portal", "lea", "Sommer2026!"], ["Test", "max", "Winter2027?"]]);
    const output = redactTableCells(cells);
    expect(output.map((cell) => cell.text)).toEqual(["Portal", "User", label.toUpperCase(), "Admin-Portal", "lea", "[redacted]", "Test", "max", "[redacted]"]);
  });

  it.each(tableLabels)("redacts the full protected row when it starts with %s", (label) => {
    const cells = makeCells([["Feature", "Value", "Owner"], [label, "Winter2027?", "another secret"]]);
    expect(redactTableCells(cells).map((cell) => cell.text)).toEqual(["Feature", "Value", "Owner", label, "[redacted]", "[redacted]"]);
  });

  it.each([false, true])("redacts ambiguous key/value labels conservatively (encoded IDs=%s)", (encoded) => {
    const tableId = "key-value";
    const indexed = makeCells([["Passwort", "Winter2027?"], ["Benutzer", "lea"], ["URL", "https://x.example"]]);
    const cells = encoded ? indexed.map(({ row, column, text }) => ({ id: `T${tableId};r${row};c${column}`, text })) : indexed;
    const expected = ["Passwort", "[redacted]", "[redacted]", "lea", "[redacted]", "https://x.example"];
    expect(redactTableCells(cells, tableId).map((cell) => cell.text)).toEqual(expected);
    const table = flattenNodeTree({ document: { id: "root", name: "Document", type: "DOCUMENT", children: [{
      id: tableId, name: "Table", type: "TABLE", children: cells.map((cell, index) => ({
        id: cell.id, name: cell.text, type: "TABLE_CELL", characters: cell.text,
        ...(encoded ? {} : { rowIndex: indexed[index]!.row, columnIndex: indexed[index]!.column }),
      })),
    }] } }).find((node) => node.id === tableId)!;
    expect(table.table?.cells.map((cell) => cell.text)).toEqual(expected);
    const legacy = evidenceBoard("KeyValueLegacyTable", [{ ...textNode(tableId, cells.map((cell) => cell.text).join("\n")), type: "TABLE", table: { cells } }]);
    const redacted = redactBoard(legacy).nodes[0]!;
    expect(redacted.table?.cells.map((cell) => cell.text)).toEqual(expected);
    expect(redacted.text).toBe(table.text);
  });

  it.each([
    [["Feature", "Value", "Effort", "Status"], ["Login", "Improved", "M", "Ready"]],
    [["Token", "Value"], ["color.primary", "blue"]],
    [["Feature", "Value"], ["Token:", "color-primary-500"]],
    [["Password reset", "Value"], ["Send link", "mail"]],
  ])("keeps unrelated table cells unchanged: %j", (...rows) => {
    const cells = makeCells(rows);
    expect(redactTableCells(cells)).toEqual(cells);
  });

  it("applies the same column and row protection during extraction and on old snapshots", () => {
    const cells = makeCells([["Portal", "User", "Passwort"], ["Admin-Portal", "lea", "Sommer2026!"], ["Passwort:", "Winter2027?", "another-secret"]]);
    const expected = redactTableCells(cells);
    const nodes = flattenNodeTree({ document: { id: "root", name: "Document", type: "DOCUMENT", children: [{
      id: "table", name: "Table", type: "TABLE", children: cells.map((cell) => ({
        id: cell.id, name: cell.text, type: "TABLE_CELL", rowIndex: cell.row, columnIndex: cell.column, characters: cell.text,
      })),
    }] } });
    const table = nodes.find((node) => node.id === "table")!;
    expect(table.table?.cells).toEqual(expected);
    expect(table.text).toBe(expected.map((cell) => cell.text).join("\n"));
    const legacy = evidenceBoard("SyntheticLegacyTable", [{ ...textNode("table", cells.map((cell) => cell.text).join("\n")), type: "TABLE", table: { cells } }]);
    expect(redactBoard(legacy).nodes[0]!.table?.cells).toEqual(expected);
    expect(redactBoard(legacy).nodes[0]!.text).toBe(table.text);
  });

  it("rebuilds only the legacy cell suffix, preserving a table prefix and public text", () => {
    const cells = makeCells([["Portal", "Passwort"], ["Data", "a"]]);
    const prefix = "Plan a workshop";
    const legacy = evidenceBoard("ShortLegacyTable", [{ ...textNode("table", `${prefix}\n${cells.map((cell) => cell.text).join("\n")}`), type: "TABLE", table: { cells } }]);
    const redacted = redactBoard(legacy).nodes[0]!;
    expect(redacted.table?.cells.map((cell) => cell.text)).toEqual(["Portal", "Passwort", "Data", "[redacted]"]);
    expect(redacted.text).toBe(`${prefix}\nPortal\nPasswort\nData\n[redacted]`);
  });

  it("uses encoded complete-rectangle IDs for extraction and legacy table redaction", () => {
    const rows = [["Portal", "User", "Passwort"], ["Admin-Portal", "lea", "Sommer2026!"], ["Passwort:", "Winter2027?", "another-secret"]];
    const cells = rows.flatMap((row, r) => row.map((text, c) => ({ id: `T5:119;row-${r};col-${c}`, text })));
    const expected = ["Portal", "User", "Passwort", "Admin-Portal", "lea", "[redacted]", "Passwort:", "[redacted]", "[redacted]"];
    expect(redactTableCells(cells, "5:119").map((cell) => cell.text)).toEqual(expected);
    const table = flattenNodeTree({ document: { id: "root", name: "Document", type: "DOCUMENT", children: [{
      id: "5:119", name: "Table", type: "TABLE", children: cells.map((cell) => ({ ...cell, name: cell.text, type: "TABLE_CELL", characters: cell.text })),
    }] } }).find((node) => node.id === "5:119")!;
    expect(table.table?.cells.map((cell) => cell.text)).toEqual(expected);
    const legacy = evidenceBoard("EncodedLegacyTable", [{ ...textNode("5:119", cells.map((cell) => cell.text).join("\n")), type: "TABLE", table: { cells } }]);
    const redacted = redactBoard(legacy).nodes[0]!;
    expect(redacted.table?.cells.map((cell) => cell.text)).toEqual(expected);
    expect(redacted.text).toBe(table.text);
  });

  it.each([
    [{ id: "unknown", text: "Passwort" }, { id: "other", text: "secret-value" }],
    [{ id: "Ttable;r0;c0", text: "Portal" }, { id: "Ttable;r0;c1", text: "Passwort" }, { id: "Ttable;r1;c1", text: "secret-value" }],
    [{ id: "Twrong;r0;c0", text: "Passwort" }, { id: "Twrong;r1;c0", text: "secret-value" }],
  ])("does not guess table coordinates from unknown, incomplete, or mismatched IDs: %j", (...cells) => {
    expect(redactTableCells(cells, "table")).toEqual(cells);
  });

  it("leaves table context unchanged when redaction is disabled", () => {
    vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "false");
    const cells = makeCells([["Passwort", "Other"], ["secret-value", "visible-value"]]);
    expect(redactTableCells(cells)).toBe(cells);
    expect(hasProtectedTableValue([{ ...textNode("table", ""), type: "TABLE", table: { cells } }])).toBe(false);
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


describe("protected credential table snapshots", () => {
  it.each(["raw", "already masked"])("discards unsafe model text for a %s value in every read path", async (kind) => {
    const secret = "synthetic-legacy-value";
    const value = kind === "raw" ? secret : "[redacted]";
    const cells = [
      { id: "head", text: "Password", row: 0, column: 0 },
      { id: "value", text: value, row: 1, column: 0 },
    ];
    const boardId = kind === "raw" ? "RawTable123" : "MaskedTable123";
    const board = evidenceBoard(boardId, [{ ...textNode("table", `Password\n${value}`), type: "TABLE", table: { cells } }]);
    board.clusters[0] = { ...board.clusters[0]!, label: `Login ${secret}`, summary: `The lab password is ${secret}.`,
      summarySource: "vision_llm", modelId: "unsafe-old-model", incomplete: true, fallbackReason: "timeout" };
    const secured = redactBoard(board);
    expect(secured.clusters[0]).toMatchObject({ summarySource: "deterministic", confirmedNodeIds: ["table"] });
    expect(secured.clusters[0]!.modelId).toBeUndefined();
    expect(secured.clusters[0]!.incomplete).toBeUndefined();
    expect(redactBoard(secured)).toEqual(secured);
    setBoard(boardId, board);
    const context = await getBoardContext({ boardId });
    const full = await getBoardContext({ boardId, nodeIds: ["table"], detail: "full" });
    chatJsonMock.mockResolvedValueOnce({ kind: "unsupported", language: "en", answer: "", evidenceIds: [] });
    const answer = await answerFromBoard({ boardId, question: "What does the login table say?" });
    const prompt = chatJsonMock.mock.calls[0]?.[1];
    expect(JSON.stringify(prompt)).toContain("[redacted]");
    const baseline = { ...evidenceBoard(boardId, []), clusters: [] };
    readBoardHistoryMock.mockResolvedValue([
      { cacheKey: "before", nodeHash: "before", createdAt: 1 }, { cacheKey: "after", nodeHash: "after", createdAt: 2 },
    ]);
    readCachedBoardMock.mockImplementation(async (key: string) => key === "before" ? baseline : board);
    const diff = await diffBoard({ boardId, compareTo: 1 });
    expect(diff.newClusters).toHaveLength(1);
    for (const result of [secured, context, full, prompt, answer, diff]) expect(JSON.stringify(result)).not.toContain(secret);
  });
});


describe("URL credential redaction", () => {
  it.each([
    "https://ece@host", "alice@example.test", "postgres://u:${DB_PASS}@host", "postgres://u:{{secret}}@host",
    "postgres://u:<password>@host", "postgres://u:***@host", "postgres://u:xxx@host",
    "postgres://u:password@host", "postgres://u:TBD@host",
  ])("redacts URL passwords in both paths and preserves %s", (unchanged) => {
    const input = `postgres://admin:synthetic-value@db.test/a redis://:synthetic-value@host ${unchanged}`;
    const expected = `postgres://admin:[redacted]@db.test/a redis://:[redacted]@host ${unchanged}`;
    expect(redactCredentials(input)).toBe(expected);
    expect(redactMessageCredentials(input)).toBe(expected);
  });

  it("handles long URL-like input without excessive backtracking", () => {
    const input = "a".repeat(100_000) + "://user:synthetic-value@host";
    expect(redactCredentials(input)).toContain("://user:[redacted]@host");
    expect(redactMessageCredentials(input)).toContain("://user:[redacted]@host");
  });

  it("redacts a stored model summary and label when read", async () => {
    const board = evidenceBoard("UrlLegacy123", [textNode("1:1", "Public text")]);
    board.clusters[0]!.label = "postgres://admin:synthetic-value@db.test";
    board.clusters[0]!.summary = "The URL is postgres://admin:synthetic-value@db.test.";
    board.clusters[0]!.summarySource = "vision_llm";
    setBoard("UrlLegacy123", board);
    const output = await getBoardContext({ boardId: "UrlLegacy123" });
    expect(JSON.stringify(output)).toContain("postgres://admin:[redacted]@db.test");
    expect(JSON.stringify(output)).not.toContain("synthetic-value");
  });
});

it.each([
  "https://example.com:8080/a@b",
  "https://x.io/a:b@c",
  "https://ece@host",
  "postgres://admin:password@db.test/path",
  "postgres://admin:${SECRET}@db.test/path",
])("masks slash-containing passwords in both paths while preserving %s", (unchanged) => {
  const text = `postgres://admin:ab/cd123@db.test/app ${unchanged}`;
  const expected = `postgres://admin:[redacted]@db.test/app ${unchanged}`;
  expect(redactCredentials(text)).toBe(expected);
  expect(redactMessageCredentials(text)).toBe(expected);
});
