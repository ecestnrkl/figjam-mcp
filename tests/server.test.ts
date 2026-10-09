import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

const handlers = vi.hoisted(() => ({ ingest: vi.fn(), context: vi.fn(), answer: vi.fn(), diff: vi.fn(), diagnose: vi.fn() }));
vi.mock("../src/tools/ingestBoard.js", () => ({ ingestBoard: handlers.ingest }));
vi.mock("../src/tools/getBoardContext.js", () => ({ getBoardContext: handlers.context }));
vi.mock("../src/tools/answerFromBoard.js", () => ({ answerFromBoard: handlers.answer }));
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
  });

  it("returns readable and structured content through tools/call", async () => {
    const output = { contextText: "Workshop evidence", clusters: [], snapshotId: "snapshot1", evidence: [], connections: [], totalMatched: 0, truncated: false,
      truncation: { remainingEvidence: 0, omittedConnections: 0, omittedRelations: 0, omittedTextConnections: 0, omittedTextRelations: 0 } };
    handlers.context.mockResolvedValue(output);
    const result = await client.callTool({ name: "get_board_context", arguments: { boardId: "Board123" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(output);
    expect(result.content).toContainEqual({ type: "text", text: output.contextText });
  });

  it("rejects malformed arguments before invoking the handler", async () => {
    const result = await client.callTool({ name: "get_board_context", arguments: { boardId: "../../secret" } }).catch(error => error);
    expect(result instanceof Error || result.isError === true).toBe(true);
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
    handlers.context.mockResolvedValue({ contextText: "invalid", clusters: "not an array" });
    const invalid = await client.callTool({ name: "get_board_context", arguments: { boardId: "Board123" } });
    expect(invalid.isError).toBe(true);
  });

  it("reports ingest progress only when requested", async () => {
    handlers.ingest.mockImplementation(async (_input, options) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      await options.onProgress?.("Fetching board", 1, 5);
      await options.onProgress?.("Persisted", 5, 5);
      return { boardId: "Board123", clusterCount: 0, summary: "Ingested" };
    });
    const updates: number[] = [];
    const request = { name: "ingest_board", arguments: { figmaFileUrl: "https://www.figma.com/board/Board123/Example" } };
    await client.callTool(request, { onprogress: update => updates.push(update.progress) });
    expect(updates).toEqual([1, 5]);
    await client.callTool(request);
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
