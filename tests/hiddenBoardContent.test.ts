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

const hiddenContents = () => [
  sticky("secret-note", "HIDDENZEPHYR synthetic notes", 2000),
  image("secret-image", 2200),
  { id: "secret-table", name: "Table", type: "TABLE", children: [
    { id: "Tsecret-table;row-1;col-1", name: "Cell", type: "TABLE_CELL", characters: "HIDDENZEPHYR synthetic cell" },
  ] },
  { id: "secret-arrow", name: "Arrow", type: "CONNECTOR", characters: "HIDDENZEPHYR synthetic arrow", connectorStart: { endpointNodeId: "secret-note" }, connectorEnd: { endpointNodeId: "public" } },
  { id: "nested", name: "Nested", type: "SECTION", children: [sticky("nested-note", "HIDDENZEPHYR nested notes")] },
];
const section = (hidden: boolean) => ({ id: "section", name: "Private section", type: "SECTION", sectionContentsHidden: hidden, children: hiddenContents() });

it("keeps hidden section contents and URL passwords out of the full ingest and read pipeline", async () => {
  fileTree.mockResolvedValue(tree([sticky("public", "postgres://admin:ab/synthetic-value@db.test/plan"), section(true)]));
  const result = await ingestBoard(input);
  const context = await getBoardContext({ boardId: fileKey });
  const direct = await Promise.all(["section", "secret-note", "Tsecret-table;row-1;col-1", "nested-note"].map(id => getBoardContext({ boardId: fileKey, nodeIds: [id] })));
  const board = await readLatestBoard(fileKey);
  expect(board?.nodes.map(node => node.id)).toEqual(["page", "public", "section"]);
  expect(result.summary).toContain("Contents hidden in FigJam; 7 elements not read");
  expect(context.text).toContain("Contents hidden in FigJam; 7 elements not read");
  for (const output of direct) expect(output.text).toContain("Contents hidden in FigJam; 7 elements not read");
  expect(JSON.stringify(chatJson.mock.calls)).toContain("postgres://admin:[redacted]@db.test");
  expect(imageFills).not.toHaveBeenCalled();
  expect(renders.mock.calls.flatMap(call => call[1] as string[])).toEqual(["public"]);
  const outputs = JSON.stringify({ result, context, direct, board, provider: chatJson.mock.calls });
  expect(outputs).not.toMatch(/HIDDENZEPHYR|synthetic-value/);
  for (const file of await readdir(cacheDirectory, { recursive: true })) {
    if (file.endsWith(".json")) expect(await readFile(path.join(cacheDirectory, file), "utf8")).not.toMatch(/HIDDENZEPHYR|synthetic-value/);
  }
  const { flattenNodeTree } = await import("../src/lib/nodeTree.js");
  const changed = section(true);
  changed.children[0] = sticky("secret-note", "A different hidden value");
  expect(flattenNodeTree(tree([section(true)]))).toEqual(flattenNodeTree(tree([changed])));
});

it.each([true, false])("reports a section visibility transition (hidden=%s) without reporting its children", async (hidden) => {
  const { diffBoard } = await import("../src/tools/diffBoard.js");
  fileTree.mockResolvedValueOnce(tree([sticky("public", "Public planning notes"), section(!hidden)]));
  await ingestBoard({ ...input, ingestMode: "max_speed" });
  fileTree.mockResolvedValue(tree([sticky("public", "Public planning notes"), section(hidden)]));
  await ingestBoard({ ...input, ingestMode: "max_speed" });
  const output = await diffBoard({ boardId: fileKey, compareTo: 1 });
  expect(output.summaryText).toContain(`Section section Private section: contents ${hidden ? "hidden" : "shown"} in FigJam`);
  expect(JSON.stringify(output)).not.toMatch(/HIDDENZEPHYR|secret-note|secret-table|secret-arrow/);
  if (hidden) {
    await ingestBoard({ ...input, ingestMode: "max_speed" });
    const latest = await readLatestBoard(fileKey);
    expect(JSON.stringify(latest)).not.toContain("HIDDENZEPHYR");
  }
});

it("never renders, interprets or counts a hidden section in balanced mode", async () => {
  fileTree.mockResolvedValue(tree([{ ...section(true), absoluteBoundingBox: box,
    characters: "Section-only text", fills: [{ type: "IMAGE", imageRef: "section-fill" }] }]));
  const result = await ingestBoard({ ...input, ingestMode: "balanced" });
  const board = await readLatestBoard(fileKey);
  const context = await getBoardContext({ boardId: fileKey });
  expect(board?.clusters).toEqual([]);
  expect(renders).not.toHaveBeenCalled();
  expect(imageFills).not.toHaveBeenCalled();
  expect(chatJson).not.toHaveBeenCalled();
  expect(context.structuredContent.totalMatched).toBe(0);
  expect(JSON.stringify({ result, context })).not.toMatch(/GENERATED PLACEHOLDER|Section-only text/);
  // Simulate a refinement written by the previous PR head, with a section cluster.
  const { persistBoard } = await import("../src/lib/persistentCache.js");
  await persistBoard({ ...board!, clusters: [{ id: "stale", nodeIds: ["section"], confirmedNodeIds: ["section"],
    boundingBox: box, label: "Old section", summary: "Old section placeholder", summarySource: "deterministic" }] });
  const restored = await getBoardContext({ boardId: fileKey });
  expect(restored.structuredContent.totalMatched).toBe(0);
  expect(JSON.stringify(restored)).not.toContain("Old section placeholder");
  // A second ordinary ingest must not restore artifacts from a cached refinement.
  await ingestBoard({ ...input, ingestMode: "balanced" });
  expect((await readLatestBoard(fileKey))?.clusters).toEqual([]);
});

it.each([true, false])("reports only visibility when an external connector crosses the section boundary (hidden=%s)", async (hidden) => {
  const { diffBoard } = await import("../src/tools/diffBoard.js");
  const makeTree = (isHidden: boolean) => tree([
    sticky("public", "Public note"),
    { id: "external-arrow", name: "Arrow", type: "CONNECTOR", characters: "Synthetic relation",
      connectorStart: { endpointNodeId: "public" }, connectorEnd: { endpointNodeId: "secret-note" } },
    { ...section(isHidden), absoluteBoundingBox: box },
  ]);
  fileTree.mockResolvedValueOnce(makeTree(!hidden));
  await ingestBoard({ ...input, ingestMode: "max_speed" });
  fileTree.mockResolvedValue(makeTree(hidden));
  await ingestBoard({ ...input, ingestMode: "max_speed" });
  if (hidden) expect((await readLatestBoard(fileKey))?.connectorEdges).toEqual([]);
  const diff = await diffBoard({ boardId: fileKey, compareTo: 1 });
  expect(diff.summaryText).toContain(`contents ${hidden ? "hidden" : "shown"} in FigJam`);
  expect(diff.stats).toMatchObject({ addedNodes: 0, removedNodes: 0, editedNodes: 0,
    newClusters: 0, removedClusters: 0, modifiedClusters: 0, addedConnections: 0, removedConnections: 0 });
  expect(JSON.stringify(diff)).not.toMatch(/New clusters|Removed clusters|Connections:|Synthetic relation|No content, name or layout changes/);
});

it("names a hidden section in ingest, direct reads and visibility diffs", async () => {
  const { diffBoard } = await import("../src/tools/diffBoard.js");
  fileTree.mockResolvedValueOnce(tree([section(false)]));
  await ingestBoard({ ...input, ingestMode: "max_speed" });
  fileTree.mockResolvedValue(tree([section(true)]));
  const result = await ingestBoard({ ...input, ingestMode: "max_speed" });
  const read = await getBoardContext({ boardId: fileKey, nodeIds: ["secret-note"] });
  const diff = await diffBoard({ boardId: fileKey, compareTo: 1 });
  expect(result.summary).toContain("Section section Private section: Contents hidden");
  expect(read.text).toContain("Section section Private section: Contents hidden");
  expect(diff.summaryText).toContain("Section section Private section: contents hidden");
});
