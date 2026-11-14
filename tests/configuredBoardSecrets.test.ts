import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBoard, setBoard } from "../src/lib/cache.js";
import { retrieveEvidence } from "../src/lib/evidence.js";
import { persistBoard, readLatestBoard } from "../src/lib/persistentCache.js";
import { getBoardContextOutputSchema } from "../src/schemas/getBoardContext.js";
import { createServer } from "../src/server.js";
import { evidenceBoard, textNode } from "./fixtures/retrieval.js";

const credentials = [
  ["16 unformatted characters", "Z9KfxW22Zr8vUk6W", "LLM_API_KEY"],
  ["32 hex characters", "18b7cf3d4f327e6b825b94acc795ab01", "FIGMA_ACCESS_TOKEN"],
  ["AIza with 35 characters", 'AIza' + "m5W7kd9Q2x".repeat(3) + "vE33I", "LLM_API_KEY"],
  ["surrounding environment whitespace", "  F7Q5Ny9wDs3Bz2Pk  ", "FIGMA_ACCESS_TOKEN"],
] as const;
const boardId = "SyntheticCredentialRead";
const node = (id: string, text: string, name = "Sticky") => ({ ...textNode(id, text), name });
let directory: string;
let server: ReturnType<typeof createServer>;
let client: Client;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "figjam-read-synthetic-"));
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", directory);
  vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "false");
  vi.stubEnv("LLM_API_KEY", "unused-offline-key");
  vi.stubEnv("FIGMA_ACCESS_TOKEN", "unused-offline-token");
  vi.stubEnv("LLM_BASE_URL", "https://synthetic.invalid/v1");
  vi.stubEnv("LLM_TEXT_MODELS", "mock-text/board");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network call in an offline test"); }));
  server = createServer();
  client = new Client({ name: "configured-secrets-test", version: "1" }, { supportedProtocolVersions: ["2025-11-25"] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});
afterEach(async () => {
  await client.close();
  await server.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function fixture(key: string) {
  const marked = (at: number) => `uniqueanchor ${"q".repeat(at - 13)}${key} remaining details`;
  const sticky = node("1:3", marked(1187), marked(1187).slice(0, 1197) + "…");
  sticky.sectionIds = [];
  const table = { ...node("2:0", "", "s".repeat(149) + key + " table"), type: "TABLE", table: { cells: [
    { id: "2:1", row: 1, column: 1, text: marked(1188) },
    { id: "2:2", row: 1, column: 2, text: "endpoint" },
  ] }, sectionIds: [] };
  const data = evidenceBoard(boardId, [
    node("1:5", marked(92)),
    node("1:6", marked(107)),
    node("1:7", marked(125)),
    node("1:8", `uniqueanchor ${key} standalone`),
    sticky, table,
  ]);
  data.clusters[0]!.label = "l".repeat(147) + key + " cluster";
  data.nodes.push(
    { ...node("0:1", "", "p".repeat(147) + key + " page"), type: "CANVAS", sectionIds: [] },
    { ...node("1:0", "", "s".repeat(67) + key + " section"), type: "SECTION", parentId: "0:1", sectionIds: [] },
  );
  data.connectorEdges = [{ connectorId: "3:1", fromNodeId: "1:3", toNodeId: "1:5", label: marked(109) }];
  return data;
}

function safeText(output: unknown, key: string): void {
  const json = JSON.stringify(output);
  expect(json).toContain("[redacted]");
  for (let start = 0; start + 8 <= key.length; start++) expect(json).not.toContain(key.slice(start, start + 8));
}

it("masks table cell text before folding internal key whitespace across a part boundary", async () => {
  const key = "Z9KfxW22Zr8v   Uk6WFN9G";
  const data = fixture(key);
  setBoard(boardId, data);
  const args = { boardId, nodeIds: ["2:0"], detail: "full", maxChars: 24000 };
  const legacy = retrieveEvidence(data, { nodeIds: ["2:0"] }).evidence;
  vi.stubEnv("LLM_API_KEY", key);
  const result = await client.callTool({ name: "get_board_context", arguments: args });
  expect(result.structuredContent).toMatchObject({ evidence: legacy.map(({ evidenceId }) => ({ evidenceId })) });
  for (const output of [result.content, result.structuredContent]) safeText(output, key.replaceAll("   ", " "));
});

describe.each(credentials)("configured board credentials: %s", (_label, value, env) => {
  const key = value.trim();
  it.each([
    ["compact page", { nodeIds: ["0:1"], maxChars: 6000 }],
    ["full read", { detail: "full", maxChars: 24000 }],
    ["table by node ID", { nodeIds: ["2:0"], detail: "full", maxChars: 24000 }],
    ["section by node ID", { nodeIds: ["1:0"], detail: "full", maxChars: 24000 }],
    ["topic", { topic: "uniqueanchor", maxChars: 24000 }],
    ["outside sections", { outsideSections: true, maxChars: 24000 }],
  ])("keeps key fragments out of both MCP outputs for a %s", async (mode, args) => {
    const data = fixture(key);
    setBoard(boardId, data);
    vi.stubEnv(env, value);
    const result = await client.callTool({ name: "get_board_context", arguments: { boardId, ...args } });
    expect(result.isError).not.toBe(true);
    safeText(result.structuredContent, key);
    safeText(result.content, key);
    if (mode === "compact page") expect(result.structuredContent).toHaveProperty("overview");
    if (mode === "topic") {
      const secretLookup = await client.callTool({ name: "get_board_context", arguments: { boardId, topic: key } });
      expect(secretLookup.structuredContent).toMatchObject({ totalMatched: 0 });
    }
  });

  it("masks both sides of a split key and preserves evidence IDs and an existing cursor", async () => {
    const data = fixture(key);
    setBoard(boardId, data);
    const args = { boardId, nodeIds: ["1:3"], detail: "full" };
    const before = retrieveEvidence(data, { nodeIds: ["1:3"] }).evidence.map((item) => item.evidenceId);
    const first = await client.callTool({ name: "get_board_context", arguments: { ...args, limit: 1 } });
    const { nextCursor: cursor } = getBoardContextOutputSchema.parse(first.structuredContent);
    expect(cursor).toBeTypeOf("string");
    vi.stubEnv(env, value);
    const result = await client.callTool({ name: "get_board_context", arguments: args });
    expect(result.structuredContent).toMatchObject({ evidence: before.map(evidenceId => ({ evidenceId })) });
    safeText(result.structuredContent, key);
    safeText(result.content, key);
    const continued = await client.callTool({ name: "get_board_context", arguments: { ...args, limit: 1, cursor } });
    expect(continued.structuredContent).toMatchObject({ evidence: [{ evidenceId: before[1] }] });
    safeText(continued.structuredContent, key);
    expect(getBoard(boardId)).toBe(data);
    expect(data.nodes.find((item) => item.id === "1:3")!.text).toContain(key);
  });

  it("sends and cites only masked evidence in answers", async () => {
    setBoard(boardId, fixture(key));
    vi.stubEnv(env, value);
    let prompt = "";
    vi.stubGlobal("fetch", vi.fn(async (input: string | Request, init?: RequestInit) => {
      expect(input instanceof Request ? input.url : input).toBe("https://synthetic.invalid/v1/chat/completions");
      const request = JSON.parse(typeof init?.body === "string" ? init.body : await (input as Request).text());
      prompt = request.messages.find((message: { role: string }) => message.role === "user").content;
      const start = prompt.indexOf('<excerpt id="') + '<excerpt id="'.length;
      const id = prompt.slice(start, prompt.indexOf('"', start));
      const content = JSON.stringify({ kind: "answer", language: "en", answer: "The source shows synthetic workshop details.", evidenceIds: [id] });
      return Response.json({ id: "mock", object: "chat.completion", created: 1, model: request.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    }));
    const result = await client.callTool({ name: "answer_from_board", arguments: { boardId, question: "What are the uniqueanchor details?" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ citations: [{ nodeId: expect.any(String) }] });
    safeText(prompt, key);
    safeText(result.structuredContent, key);
    safeText(result.content, key);
  });

  it("shows masked diff excerpts while leaving saved snapshots intact", async () => {
    vi.stubEnv(env, value);
    const before = evidenceBoard(boardId, []);
    await persistBoard({ ...before, cacheKey: "before", createdAt: 1 });
    const current = fixture(key);
    // The first 160 characters of an added node in the diff include a key fragment.
    current.nodes[0]!.text = "d".repeat(147) + key + " diff";
    await persistBoard({ ...current, cacheKey: "after", createdAt: 2 });
    const result = await client.callTool({ name: "diff_board", arguments: { boardId } });
    expect(result.isError).not.toBe(true);
    safeText(result.structuredContent, key);
    safeText(result.content, key);
    expect((await readLatestBoard(boardId))!.nodes[0]!.text).toBe(current.nodes[0]!.text);
  });

  it.each(["cluster", "section"])("masks a scoped argument key before the ingest %s summary is shortened", async (kind) => {
    const note = { id: "1:2", name: "Sticky", type: "STICKY",
      characters: "s".repeat(45) + key + " note", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 } };
    const children = kind === "cluster" ? [note] : [{ id: "1:0", name: "s".repeat(67) + key + " section", type: "SECTION",
      absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 200 }, children: [note] }];
    const raw = { document: { id: "0:0", type: "DOCUMENT", name: "Synthetic", children: [
      { id: "0:1", name: "Page", type: "CANVAS", children },
    ] } };
    const fetchMock = vi.fn(async () => Response.json(raw));
    vi.stubGlobal("fetch", fetchMock);
    const result = await client.callTool({ name: "ingest_board", arguments: {
      figmaFileUrl: `https://www.figma.com/board/${boardId}/Synthetic`, ingestMode: "max_speed", figmaAccessToken: value,
    } });
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`https://api.figma.com/v1/files/${boardId}`, expect.objectContaining({
      headers: { "X-Figma-Token": key },
    }));
    safeText(result.structuredContent, key);
    safeText(result.content, key);
    expect((await readLatestBoard(boardId))!.nodes.find((item) => item.id === "1:2")!.text).toContain(key);
  });
});
