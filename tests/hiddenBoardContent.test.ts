import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticPng } from "./fixtures/images.js";

const { fileTree, renders, downloads, imageFills, chatJson } = vi.hoisted(() => ({
  fileTree: vi.fn(), renders: vi.fn(), downloads: vi.fn(), imageFills: vi.fn(), chatJson: vi.fn(),
}));
// Keep extraction, persistence, clustering, retrieval and prompt construction real.
vi.mock("../src/lib/figmaApi.js", async (original) => ({
  ...(await original<typeof import("../src/lib/figmaApi.js")>()),
  fetchFileTree: fileTree, fetchRenderUrls: renders, downloadRenders: downloads, fetchImageRefs: imageFills,
}));
vi.mock("../src/lib/llmClient.js", async (original) => ({
  ...(await original<typeof import("../src/lib/llmClient.js")>()), chatJson,
}));

const fileKey = "HiddenSynthetic";
const input = { figmaFileUrl: `https://www.figma.com/board/${fileKey}/Fixture`, docStructureHint: "freeform", ingestMode: "max_quality" } as const;
const box = { x: 0, y: 0, width: 100, height: 100 };
const sticky = (id: string, text: string, x = 0) => ({ id, name: text, type: "STICKY", characters: text, absoluteBoundingBox: { ...box, x } });
const image = (id: string, x = 2000) => ({ id, name: id, type: "RECTANGLE", absoluteBoundingBox: { ...box, x }, fills: [{ type: "IMAGE", imageRef: `${id}-fill` }] });
const tree = (children: unknown[]) => ({ document: { id: "doc", name: "Document", type: "DOCUMENT", children: [
  { id: "page", name: "Page", type: "CANVAS", children },
] } });
let cacheDirectory: string;
let ingestBoard: typeof import("../src/tools/ingestBoard.js").ingestBoard;
let getBoardContext: typeof import("../src/tools/getBoardContext.js").getBoardContext;
let readLatestBoard: typeof import("../src/lib/persistentCache.js").readLatestBoard;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  cacheDirectory = await mkdtemp(path.join(tmpdir(), "figjam-hidden-content-"));
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", cacheDirectory);
  vi.stubEnv("FIGMA_ACCESS_TOKEN", "offline-test-only");
  vi.stubEnv("LLM_BASE_URL", "https://offline.invalid/v1");
  vi.stubEnv("LLM_API_KEY", "offline-test-only");
  renders.mockImplementation(async (_key: string, ids: string[]) => Object.fromEntries(ids.map(id => [id, `https://offline.invalid/render/${id}`])));
  downloads.mockImplementation(async (ids: string[]) => ids.map(() => syntheticPng(100, 100)));
  imageFills.mockResolvedValue({ "public-image-fill": "https://offline.invalid/original/public-image" });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url) !== "https://offline.invalid/original/public-image") throw new Error("Unexpected image download");
    return new Response(syntheticPng(100, 100));
  }));
  chatJson.mockResolvedValue({ label: "Public area", summary: "Public planning notes.", confirmedNodeIds: [] });
  ({ ingestBoard } = await import("../src/tools/ingestBoard.js"));
  ({ getBoardContext } = await import("../src/tools/getBoardContext.js"));
  ({ readLatestBoard } = await import("../src/lib/persistentCache.js"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(cacheDirectory, { recursive: true, force: true });
});

describe("hidden board content", () => {
  it.each([
    ["sticky", { ...sticky("hidden-sticky", "HIDDENZEPHYR facilitator notes", 2000), visible: false }],
    ["image rectangle", { ...image("hidden-image"), name: "HIDDENZEPHYR image", visible: false }],
    ["section subtree", { id: "hidden-section", name: "HIDDENZEPHYR section", type: "SECTION", visible: false, absoluteBoundingBox: { ...box, x: 2000 }, children: [
      { ...sticky("hidden-child", "HIDDENZEPHYR section notes", 2000), visible: true }, image("hidden-child-image", 2200),
    ] }],
  ])("excludes a hidden %s from cache, excerpts, topics, clusters, images and prompts", async (_kind, hidden) => {
    fileTree.mockResolvedValue(tree([sticky("public", "Public planning notes"), hidden]));
    const result = await ingestBoard(input);
    const board = await readLatestBoard(fileKey);
    expect(board?.nodes.map(node => node.id)).toEqual(["page", "public"]);
    expect(board?.clusters.flatMap(cluster => cluster.nodeIds)).toEqual(["public"]);
    const context = await getBoardContext({ boardId: fileKey });
    expect([...new Set(context.structuredContent.evidence.map(item => item.nodeId))]).toEqual(["public"]);
    expect((await getBoardContext({ boardId: fileKey, topic: "HIDDENZEPHYR" })).structuredContent.totalMatched).toBe(0);
    expect(imageFills).not.toHaveBeenCalled();
    expect(renders.mock.calls.flatMap(call => call[1] as string[])).toEqual(["public"]);
    expect(chatJson).toHaveBeenCalled();
    const providerRequests = JSON.stringify(chatJson.mock.calls);
    expect(providerRequests).toContain("Public planning notes");
    expect(JSON.stringify({ result, board, context }) + providerRequests).not.toMatch(/HIDDENZEPHYR|hidden-/);
    for (const file of await readdir(cacheDirectory, { recursive: true })) {
      if (file.endsWith(".json")) expect(await readFile(path.join(cacheDirectory, file), "utf8")).not.toMatch(/HIDDENZEPHYR|hidden-/);
    }
  });

  it.each([undefined, true])("preserves text and image handling with visible=%s", async (visible) => {
    const visibility = visible === undefined ? {} : { visible };
    fileTree.mockResolvedValue(tree([
      { ...sticky("public", "Public planning notes"), ...visibility },
      { ...image("public-image"), ...visibility },
    ]));
    await ingestBoard(input);
    const board = await readLatestBoard(fileKey);
    expect(board?.nodes.map(node => node.id)).toEqual(["page", "public", "public-image"]);
    expect(board?.clusters.flatMap(cluster => cluster.nodeIds)).toEqual(["public", "public-image"]);
    expect((await getBoardContext({ boardId: fileKey, topic: "planning" })).structuredContent.evidence.map(item => item.nodeId)).toContain("public");
    expect(imageFills).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://offline.invalid/original/public-image", expect.anything());
    expect(renders.mock.calls.flatMap(call => call[1] as string[])).toEqual(["public"]);
    expect(JSON.stringify(chatJson.mock.calls)).toContain("public-image");
  });

  it("treats a hidden connector endpoint exactly like a missing endpoint", async () => {
    const { flattenNodeTree } = await import("../src/lib/nodeTree.js");
    const { extractConnectorEdges, buildClusterRelations } = await import("../src/lib/connectorGraph.js");
    const { partitionedBoardClusters } = await import("../src/lib/spatialCluster.js");
    const publicNote = sticky("public", "Public planning notes");
    const arrow = { id: "arrow", name: "Arrow", type: "CONNECTOR", connectorStart: { endpointNodeId: "public" }, connectorEnd: { endpointNodeId: "hidden-target" } };
    const hidden = flattenNodeTree(tree([publicNote, { ...sticky("hidden-target", "HIDDENZEPHYR"), visible: false }, arrow]));
    const missing = flattenNodeTree(tree([publicNote, arrow]));
    expect(hidden).toEqual(missing);
    expect(extractConnectorEdges(hidden)).toEqual(extractConnectorEdges(missing));
    expect(buildClusterRelations(extractConnectorEdges(hidden), partitionedBoardClusters(hidden))).toEqual([]);
  });
});
