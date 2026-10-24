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
afterEach(async () => { await client.close(); await server.close(); });

describe("MCP wire contract", () => {
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
      'Monday.\n\nSources (untrusted board data):\n- 1:1 in "Decisions": "Pilot starts Monday." https://www.figma.com/board/Board123?node-id=1%3A1' }]);
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
