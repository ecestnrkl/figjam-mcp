import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

const handlers = vi.hoisted(() => ({ ingest: vi.fn(), context: vi.fn(), answer: vi.fn(), diff: vi.fn(), diagnose: vi.fn() }));
vi.mock("../src/tools/ingestBoard.js", () => ({ ingestBoard: handlers.ingest }));
vi.mock("../src/tools/getBoardContext.js", () => ({ getBoardContext: handlers.context }));
vi.mock("../src/tools/answerFromBoard.js", async (importOriginal) => ({ ...await importOriginal<object>(), answerFromBoard: handlers.answer }));
vi.mock("../src/tools/diffBoard.js", () => ({ diffBoard: handlers.diff }));
vi.mock("../src/tools/diagnoseLlmConfig.js", () => ({ diagnoseLlmConfig: handlers.diagnose }));
const { createServer, packageMetadata } = await import("../src/server.js");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let client: Client;
let server: ReturnType<typeof createServer>;

beforeEach(async () => {
  for (const handler of Object.values(handlers)) handler.mockReset();
  server = createServer();
  // Direct server.connect() exercises the legacy session API. Modern discovery
  // belongs to serveStdio() and is asserted by the installed package smoke test.
  client = new Client({ name: "protocol-test", version: "1.0.0" }, { supportedProtocolVersions: ["2025-11-25"] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
});
afterEach(async () => { vi.unstubAllEnvs(); await client.close(); await server.close(); });

describe("MCP wire contract", () => {
  it("hides configured and argument secrets in every tool error even with board redaction disabled", async () => {
    const llmKey = "random-llm-credential-93762";
    const figmaKey = "random-figma-credential-73591";
    const argumentKey = "random-argument-credential-52684";
    vi.stubEnv("LLM_API_KEY", llmKey);
    vi.stubEnv("FIGMA_ACCESS_TOKEN", figmaKey);
    vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "false");
    for (const [name, handler, args] of [
      ["ingest_board", handlers.ingest, { figmaFileUrl: "https://www.figma.com/board/Synthetic/Fixture", figmaAccessToken: argumentKey }],
      ["get_board_context", handlers.context, { boardId: "Synthetic" }],
      ["answer_from_board", handlers.answer, { boardId: "Synthetic", question: "Question?" }],
      ["diff_board", handlers.diff, { boardId: "Synthetic", compareTo: 1 }],
      ["diagnose_llm_config", handlers.diagnose, {}],
    ] as const) {
      const extra = name === "ingest_board" ? ` ${argumentKey}` : "";
      handler.mockRejectedValue(new Error(`Failure ${llmKey} ${figmaKey}${extra}`));
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(llmKey);
      expect(JSON.stringify(result)).not.toContain(figmaKey);
      expect(JSON.stringify(result)).not.toContain(argumentKey);
      expect(JSON.stringify(result)).toContain("[redacted]");
    }
  });

  it("sanitizes summary and persistence warnings before they reach the host", async () => {
    vi.stubEnv("LLM_API_KEY", "random-key-173650");
    handlers.ingest.mockResolvedValue({ boardId: "Synthetic", ingestMode: "balanced", clusterCount: 0, relationCount: 0,
      summary: "Summary random-key-173650", persistenceWarning: "Warning random-key-173650" });
    const result = await client.callTool({ name: "ingest_board", arguments: { figmaFileUrl: "https://www.figma.com/board/Synthetic/Fixture" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ summary: "Summary [redacted]", persistenceWarning: "Warning [redacted]" });
    expect(JSON.stringify(result)).not.toContain("random-key-173650");
  });

  it("advertises the actual package version and five accurately annotated tools", async () => {
    expect(client.getServerVersion()?.version).toBe(packageMetadata.version);
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(["answer_from_board", "diagnose_llm_config", "diff_board", "get_board_context", "ingest_board"]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(tool.name !== "ingest_board");
      expect(tool.annotations?.openWorldHint).toBe(!["get_board_context", "diff_board"].includes(tool.name));
    }
    const context = tools.find(tool => tool.name === "get_board_context");
    expect(context?.description).toContain("overview.text");
    expect(context?.description).toContain("For multiple pages, read each page separately with detail: \"auto\", maxChars: 24000 and follow nextCursor with unchanged arguments; page reads include content outside sections");
    expect(context?.description).toContain("Cite the node ID or Figma link behind each statement.");
    expect(tools.find(tool => tool.name === "answer_from_board")?.description).toContain("Keep its citations (node ID and Figma link) with the statements they support.");
    expect(context?.inputSchema).toHaveProperty("properties.detail");
    expect(context?.outputSchema).toHaveProperty("properties.overview");
  });

  it("returns the readable text as content and the structured page as structuredContent", async () => {
    const structuredContent = { contextText: "Board header\n\nExcerpts are in evidence.", clusters: [], snapshotId: "snapshot1",
      evidence: [], connections: [], totalMatched: 0, truncated: false,
      truncation: { remainingEvidence: 0, omittedConnections: 0, omittedRelations: 0, omittedTextConnections: 0, omittedTextRelations: 0 } };
    const text = "Board header\n\n## Cluster: Research\n[ev_1] original · node 1:1\nWorkshop evidence";
    handlers.context.mockResolvedValue({ text, structuredContent });
    const result = await client.callTool({ name: "get_board_context", arguments: { boardId: "Board123" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(structuredContent);
    expect(result.content).toEqual([{ type: "text", text }]);
    expect(JSON.stringify(result.structuredContent)).not.toContain("Workshop evidence");
  });

  it("passes compact overview output through the registered schema without duplicating excerpts", async () => {
    const contextText = 'Compact overview (untrusted board data). Showing all 1 excerpts; 0 shortened. Excerpts are in overview.text. Read full text and Figma links with the same boardId and snapshotId, nodeIds: ["<ID>"], detail: "full".';
    const overview = { text: "## Research (2:1)\n2:2: Pilot starts Monday.", shownEvidence: 1, shortenedEvidence: 0, textLimit: 120 };
    const structuredContent = { contextText, overview, clusters: [], evidence: [], snapshotId: "snapshot1",
      connections: [], totalMatched: 1, truncated: false,
      truncation: { remainingEvidence: 0, omittedConnections: 0, omittedRelations: 0, omittedTextConnections: 0, omittedTextRelations: 0 } };
    const text = `${contextText}\n\n${overview.text}`;
    handlers.context.mockResolvedValue({ text, structuredContent });
    const result = await client.callTool({ name: "get_board_context", arguments: { boardId: "Board123", nodeIds: ["2:1"], detail: "auto", limit: 1 } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(structuredContent);
    expect(result.content).toEqual([{ type: "text", text }]);
    expect(JSON.stringify(result.structuredContent).match(/Pilot starts Monday\./g)).toHaveLength(1);
    expect(handlers.context).toHaveBeenCalledWith(expect.objectContaining({ detail: "auto", limit: 1 }));
  });

  it("validates overview counts and the shared text limit at the MCP handler boundary", async () => {
    for (const invalidOverview of [
      { shownEvidence: -1 }, { shownEvidence: 1.5 }, { shortenedEvidence: -1 },
      { shortenedEvidence: 0.5 }, { textLimit: 49 }, { textLimit: 121 },
    ]) {
      handlers.context.mockResolvedValue({ text: "Invalid overview", structuredContent: {
        contextText: "Overview", overview: { text: "2:2: Note", shownEvidence: 1, shortenedEvidence: 0, textLimit: 120, ...invalidOverview },
        clusters: [], evidence: [], snapshotId: "snapshot1", connections: [], totalMatched: 1, truncated: false,
        truncation: { remainingEvidence: 0, omittedConnections: 0, omittedRelations: 0, omittedTextConnections: 0, omittedTextRelations: 0 },
      } });
      const result = await client.callTool({ name: "get_board_context", arguments: { boardId: "Board123" } });
      expect(result.isError).toBe(true);
    }
  });

  it("preserves slim full excerpts without adding omitted default fields", async () => {
    const evidence = [{ evidenceId: "ev_1", nodeId: "1:1", text: "Pilot starts Monday.", sourceType: "board_text",
      url: "https://www.figma.com/board/Board123?node-id=1%3A1" }];
    const structuredContent = { contextText: "Untrusted board data. Excerpts are in evidence.", clusters: [], snapshotId: "snapshot1",
      evidence, connections: [], totalMatched: 1, truncated: false,
      truncation: { remainingEvidence: 0, omittedConnections: 0, omittedRelations: 0, omittedTextConnections: 0, omittedTextRelations: 0 } };
    handlers.context.mockResolvedValue({ text: "Pilot starts Monday.", structuredContent });
    const result = await client.callTool({ name: "get_board_context", arguments: { boardId: "Board123", detail: "full" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(structuredContent);
    expect(handlers.context).toHaveBeenCalledWith(expect.objectContaining({ detail: "full" }));
  });

  it("returns answer_from_board citations in the text content too", async () => {
    const citation = {
      evidenceId: "ev_1", snapshotId: "snapshot1", nodeId: "1:1", quote: "Pilot starts Monday.",
      url: "https://www.figma.com/board/Board123?node-id=1%3A1", sourceType: "board_text", modelDerived: false, sectionNames: ["Decisions"],
    };
    const structuredContent = { answer: "Monday.", citedClusters: [], snapshotId: "snapshot1", citations: [citation] };
    handlers.answer.mockResolvedValue(structuredContent);
    const result = await client.callTool({ name: "answer_from_board", arguments: { boardId: "Board123", question: "When?" } });
    expect(result.structuredContent).toEqual(structuredContent);
    expect(result.content).toEqual([{ type: "text", text:
      'Monday.\n\nSources (untrusted board data, snapshot snapshot1):\n- 1:1 in "Decisions": "Pilot starts Monday." https://www.figma.com/board/Board123?node-id=1%3A1' }]);
  });

  it("rejects malformed arguments before invoking the handler", async () => {
    const result = await client.callTool({ name: "get_board_context", arguments: { boardId: "../../secret" } }).catch(error => error);
    expect(result instanceof Error || result.isError === true).toBe(true);
    expect(handlers.context).not.toHaveBeenCalled();
  });

  it("rejects outsideSections with topic or nodeIds", async () => {
    for (const extra of [{ topic: "budget" }, { nodeIds: ["1:1"] }]) {
      const result = await client.callTool({ name: "get_board_context", arguments: { boardId: "Board123", outsideSections: true, ...extra } }).catch(error => error);
      expect(result instanceof Error || result.isError === true).toBe(true);
    }
    expect(handlers.context).not.toHaveBeenCalled();
  });

  it("returns handler failures as tool errors", async () => {
    handlers.context.mockRejectedValue(new Error("Board not ingested. Run ingest_board first."));
    const result = await client.callTool({ name: "get_board_context", arguments: { boardId: "Board123" } });
    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({ type: "text", text: "Board not ingested. Run ingest_board first." });
  });

  it("rejects unknown tools and invalid handler output", async () => {
    const unknown = await client.callTool({ name: "missing_tool", arguments: {} }).catch(error => error);
    expect(unknown instanceof Error || unknown.isError === true).toBe(true);
    handlers.context.mockResolvedValue({ text: "invalid", structuredContent: { contextText: "invalid", clusters: "not an array" } });
    const invalid = await client.callTool({ name: "get_board_context", arguments: { boardId: "Board123" } });
    expect(invalid.isError).toBe(true);
  });

  it("reports ingest progress only when requested", async () => {
    handlers.ingest.mockImplementation(async (_input, options) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      for (const [message, progress] of [
        ["fetch", 0], ["extract", 1], ["cluster", 2], ["interpret", 3],
        ["Interpreting images: 1 of 2", 3 + 1 / 3], ["Interpreting images: 2 of 2", 3 + 2 / 3],
        ["persist", 4], ["complete", 5],
      ] as const) await options.onProgress?.(message, progress, 5);
      return { boardId: "Board123", clusterCount: 0, summary: "Ingested" };
    });
    const updates: Array<{ message?: string; progress: number; total?: number }> = [];
    const request = { name: "ingest_board", arguments: { figmaFileUrl: "https://www.figma.com/board/Board123/Example" } };
    await client.callTool(request, { onprogress: update => updates.push(update) });
    expect(updates.map(({ message, progress, total }) => [message, progress, total])).toEqual([
      ["fetch", 0, 5], ["extract", 1, 5], ["cluster", 2, 5], ["interpret", 3, 5],
      ["Interpreting images: 1 of 2", 3 + 1 / 3, 5], ["Interpreting images: 2 of 2", 3 + 2 / 3, 5],
      ["persist", 4, 5], ["complete", 5, 5],
    ]);
    await client.callTool(request);
    expect(updates).toHaveLength(8);
    expect(handlers.ingest.mock.calls[1]?.[1].onProgress).toBeUndefined();
  });

  it.each(["ingest_board", "answer_from_board", "diagnose_llm_config"])("cancels %s through the request signal", async name => {
    const started = deferred();
    const stopped = deferred();
    const handler = name === "ingest_board" ? handlers.ingest : name === "answer_from_board" ? handlers.answer : handlers.diagnose;
    handler.mockImplementation((...args) => {
      const options = name === "diagnose_llm_config" ? args[0] : args[1];
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => { stopped.resolve(); reject(options.signal.reason); }, { once: true });
        started.resolve();
      });
    });
    const controller = new AbortController();
    const arguments_ = name === "ingest_board" ? { figmaFileUrl: "https://www.figma.com/board/Board123/Example" } : name === "answer_from_board" ? { boardId: "Board123", question: "What changed?" } : {};
    const pending = client.callTool({ name, arguments: arguments_ }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBeDefined();
    await started.promise;
    controller.abort();
    await stopped.promise;
    await rejected;
  });
});

const BOARD_URL = "https://www.figma.com/board/Board123/Example";
const contextOutput = { contextText: "Context.", clusters: [], snapshotId: "snapshot1", evidence: [], connections: [], totalMatched: 0, truncated: false,
  truncation: { remainingEvidence: 0, omittedConnections: 0, omittedRelations: 0, omittedTextConnections: 0, omittedTextRelations: 0 } };
const diffOutput = { boardId: "Board123", baselineCreatedAt: "2026-01-01T00:00:00.000Z", currentCreatedAt: "2026-01-02T00:00:00.000Z",
  summaryText: "No changes.", newClusters: [], removedClusters: [], modifiedClusters: [], addedConnections: [], removedConnections: [],
  stats: { addedNodes: 0, removedNodes: 0, editedNodes: 0, movedNodes: 0, newClusters: 0, removedClusters: 0, modifiedClusters: 0, unchangedClusters: 0, addedConnections: 0, removedConnections: 0 } };
const diagnoseOutput = { ok: true, preset: "synthetic", visionModels: [], textModels: [], fastTextModels: [], providerRequireParameters: false, checks: [], summary: "All checks passed." };

/** Every tool with arguments that are valid and a handler result the output schema accepts. */
const toolCases = [
  { name: "ingest_board", handler: () => handlers.ingest, args: { figmaFileUrl: BOARD_URL },
    result: { boardId: "Board123", clusterCount: 0, summary: "Ingested." }, text: "Ingested.",
    params: "figmaFileUrl, figmaAccessToken, docStructureHint, customPhases, ingestMode, forceFullIngest, focusNodeIds" },
  { name: "get_board_context", handler: () => handlers.context, args: { boardId: "Board123" },
    result: { text: "Context.", structuredContent: contextOutput }, text: "Context.",
    params: "boardId, topic, nodeIds, outsideSections, snapshotId, detail, limit, cursor, maxChars" },
  { name: "answer_from_board", handler: () => handlers.answer, args: { boardId: "Board123", question: "What changed?" },
    result: { answer: "Nothing.", citedClusters: [], snapshotId: "snapshot1", citations: [] }, text: "Nothing.\n\nSnapshot snapshot1.",
    params: "boardId, question, snapshotId" },
  { name: "diff_board", handler: () => handlers.diff, args: { boardId: "Board123" },
    result: diffOutput, text: "No changes.", params: "boardId, compareTo" },
  { name: "diagnose_llm_config", handler: () => handlers.diagnose, args: {},
    result: diagnoseOutput, text: "All checks passed.", params: "" },
] as const;

describe("input keys hosts send", () => {
  it.each([
    ["ingest_board", { figmaFileUrl: BOARD_URL, ingest_mode: "max_speed" }, "ingest_mode — did you mean ingestMode?"],
    ["ingest_board", { figmaFileUrl: BOARD_URL, force_full_ingest: true }, "force_full_ingest — did you mean forceFullIngest?"],
    ["ingest_board", { figma_file_url: BOARD_URL }, "figma_file_url — did you mean figmaFileUrl?"],
    ["get_board_context", { boardId: "Board123", node_ids: ["5:8"] }, "node_ids — did you mean nodeIds?"],
    ["get_board_context", { boardId: "Board123", NodeIds: ["5:8"] }, "NodeIds — did you mean nodeIds?"],
    ["get_board_context", { boardId: "Board123", max_chars: 4000 }, "max_chars — did you mean maxChars?"],
    ["get_board_context", { board_id: "Board123" }, "board_id — did you mean boardId?"],
    ["answer_from_board", { boardId: "Board123", question: "Why?", snapshot_id: "abc" }, "snapshot_id — did you mean snapshotId?"],
    ["diff_board", { boardId: "Board123", "compare-to": 2 }, "compare-to — did you mean compareTo?"],
  ] as const)("ends %s with a suggestion for %j before any work", async (name, args, suggestion) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(`Unknown argument ${suggestion}`);
    expect(JSON.stringify(result.content)).toContain("Nothing was done.");
    expect(toolCases.every(tool => tool.handler().mock.calls.length === 0)).toBe(true);
  });

  it("names several misspelled keys in one message", async () => {
    const result = await client.callTool({ name: "get_board_context", arguments: { boardId: "Board123", node_ids: ["5:8"], max_chars: 4000, foo: 1 } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text:
      "Unknown argument node_ids — did you mean nodeIds? Unknown argument max_chars — did you mean maxChars? Nothing was done." }]);
  });

  it.each(toolCases)("runs $name with an unknown key and names it without its value", async ({ name, handler, args, result: output, text, params }) => {
    handler().mockResolvedValue(output);
    const secret = "unknown-value-secret-7431";
    const result = await client.callTool({ name, arguments: { ...args, foo: secret, nodeID: [secret] } });
    expect(result.isError).not.toBe(true);
    const expected = `Ignored unknown arguments foo, nodeID; ${name} takes ${params || "no arguments"}.`;
    expect(result.structuredContent).toMatchObject({ ignoredArguments: ["foo", "nodeID"] });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(handler()).toHaveBeenCalledTimes(1);
    expect(handler().mock.calls[0]![0]).not.toHaveProperty("foo");
    const textContent = (result.content as Array<{ text: string }>)[0]!.text;
    if (name === "get_board_context") {
      // The sentence travels into the handler, which counts it against maxChars.
      expect(handler().mock.calls[0]![1]).toEqual({ notices: [expected] });
    } else {
      expect(textContent).toBe(`${text}\n\n${expected}`);
    }
  });

  it.each(toolCases)("adds neither text nor ignoredArguments to $name without unknown keys", async ({ name, handler, args, result: output, text }) => {
    handler().mockResolvedValue(output);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).not.toHaveProperty("ignoredArguments");
    expect(JSON.stringify(result.content)).not.toContain("Ignored unknown");
    if (name === "get_board_context") expect(handler()).toHaveBeenCalledWith(expect.objectContaining(args));
    else expect((result.content as Array<{ text: string }>)[0]!.text).toBe(text);
  });

  it("takes a single unknown key in the singular", async () => {
    handlers.diagnose.mockResolvedValue(diagnoseOutput);
    const result = await client.callTool({ name: "diagnose_llm_config", arguments: { verbose: true } });
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe("All checks passed.\n\nIgnored unknown argument verbose; diagnose_llm_config takes no arguments.");
  });

  it("advertises ignoredArguments on every output and leaves the inputs open", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) expect((tool.outputSchema?.properties as Record<string, unknown>).ignoredArguments).toMatchObject({ type: "array" });
    for (const tool of tools) expect(tool.inputSchema).not.toHaveProperty("additionalProperties", false);
  });
});

describe("boardId as a key or a URL", () => {
  it("advertises boardId as a key or URL without a pattern", async () => {
    const { tools } = await client.listTools();
    for (const name of ["get_board_context", "answer_from_board", "diff_board"]) {
      const boardId = (tools.find(tool => tool.name === name)!.inputSchema.properties as Record<string, Record<string, unknown>>).boardId!;
      expect(boardId).not.toHaveProperty("pattern");
      expect(boardId).toMatchObject({ type: "string", minLength: 6, maxLength: 2048 });
      expect(boardId.description).toMatch(/key.*URL/);
    }
  });

  it.each([
    ["get_board_context", { boardId: BOARD_URL }],
    ["answer_from_board", { boardId: "https://www.figma.com/design/Board123/Example?node-id=5-87", question: "What changed?" }],
    ["diff_board", { boardId: BOARD_URL }],
  ] as const)("hands the board URL of %s to the tool", async (name, args) => {
    const tool = toolCases.find(candidate => candidate.name === name)!;
    tool.handler().mockResolvedValue(tool.result);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    expect(tool.handler().mock.calls[0]![0].boardId).toBe(args.boardId);
  });

  it.each([
    ["not-a-board!", "ASCII-alphanumeric Figma file key"],
    ["https://example.com/board/Board123/Example", "Expected a Figma URL like https://www.figma.com/board/<file_key>/<name>"],
    ["https://www.figma.com/files/recent", "ASCII-alphanumeric Figma file key"],
    ["abc", "boardId is too short to be a Figma file key"],
  ])("rejects the boardId %j", async (boardId, message) => {
    const result = await client.callTool({ name: "get_board_context", arguments: { boardId } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(message);
    expect(handlers.context).not.toHaveBeenCalled();
  });
});
