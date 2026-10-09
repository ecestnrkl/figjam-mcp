import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BoardData, Cluster, NormalizedNode, RefinedCluster } from "../src/types.js";

const { fileTreeMock, metadataMock, screenshotMock, visionMock } = vi.hoisted(() => ({
  fileTreeMock: vi.fn(), metadataMock: vi.fn(), screenshotMock: vi.fn(), visionMock: vi.fn(),
}));
// Only the external boundaries are mocked. Normalization, hashes, clustering,
// source snapshots, refinement cache, history, context and diff run together.
vi.mock("../src/lib/figmaApi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/figmaApi.js")>()),
  fetchFileTree: fileTreeMock, fetchFileMetadata: metadataMock, fetchScreenshot: screenshotMock,
}));
vi.mock("../src/lib/visionInterpreter.js", () => ({ refineClusterWithVision: visionMock }));

const fileKey = "OfflineBoard";
const input = { figmaFileUrl: `https://www.figma.com/board/${fileKey}/Fixture`, docStructureHint: "freeform", ingestMode: "max_quality" } as const;
const box = { x: 0, y: 0, width: 100, height: 100 };
const sticky = (id: string, text: string, x = 0) => ({ id, name: "Sticky", type: "STICKY", characters: text, absoluteBoundingBox: { ...box, x } });
const imageNode = (id: string, x: number) => ({ id, name: "Image", type: "RECTANGLE", absoluteBoundingBox: { ...box, x }, fills: [{ type: "IMAGE", imageRef: `image-${id}` }] });
const table = (value: string) => ({ id: "table", name: "Budget table", type: "TABLE", absoluteBoundingBox: box, children: [
  { id: "Ttable;row;cell", name: "Budget", type: "TABLE_CELL", characters: value, rowIndex: 0, columnIndex: 1 },
] });
function boardTree(children: unknown[], version = "v1") {
  return { version, lastModified: version === "v1" ? "2026-10-08T12:00:00Z" : "2026-10-08T13:00:00Z",
    document: { id: "doc", name: "Document", type: "DOCUMENT", children: [
      { id: "page", name: "Page", type: "CANVAS", children },
    ] } };
}
let activeTree: ReturnType<typeof boardTree>;
let cacheDirectory: string;
let ingestBoard: typeof import("../src/tools/ingestBoard.js").ingestBoard;
let getBoardContext: typeof import("../src/tools/getBoardContext.js").getBoardContext;
let diffBoard: typeof import("../src/tools/diffBoard.js").diffBoard;
let persistence: typeof import("../src/lib/persistentCache.js");
let memory: typeof import("../src/lib/cache.js");
function refine(cluster: Cluster, _images: Buffer[], nodes: NormalizedNode[]): RefinedCluster {
  return { ...cluster, label: `Evidence ${cluster.nodeIds[0]}`, summary: nodes.map(node => node.text || node.name).join(" | "),
    confirmedNodeIds: [...cluster.nodeIds], summarySource: "vision_llm", modelId: "offline-vision" };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  cacheDirectory = await mkdtemp(path.join(tmpdir(), "figjam-ingest-integration-"));
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", cacheDirectory);
  vi.stubEnv("FIGMA_ACCESS_TOKEN", "offline-test-only");
  vi.stubEnv("LLM_BASE_URL", "https://offline.invalid/v1");
  vi.stubEnv("LLM_API_KEY", "offline-test-only");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network access in offline integration test"); }));
  activeTree = boardTree([table("Budget 100")]);
  fileTreeMock.mockImplementation(async () => activeTree);
  metadataMock.mockImplementation(async () => ({ version: activeTree.version }));
  screenshotMock.mockResolvedValue([Buffer.from("offline-image")]);
  visionMock.mockImplementation(refine);
  ({ ingestBoard } = await import("../src/tools/ingestBoard.js"));
  ({ getBoardContext } = await import("../src/tools/getBoardContext.js"));
  ({ diffBoard } = await import("../src/tools/diffBoard.js"));
  persistence = await import("../src/lib/persistentCache.js");
  memory = await import("../src/lib/cache.js");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await rm(cacheDirectory, { recursive: true, force: true });
});

describe("offline ingest pipeline with actual persistent cache", () => {
  it("refreshes edited TABLE cells, source evidence and semantic diff", async () => {
    const before = await ingestBoard(input);
    activeTree = boardTree([table("Budget 999")], "v2");
    const after = await ingestBoard(input);
    expect(after.snapshotId).not.toBe(before.snapshotId);
    expect(visionMock).toHaveBeenCalledTimes(2);
    expect(screenshotMock.mock.calls.map(call => call[1])).toEqual([["table"], ["table"]]);
    const persisted = await persistence.readLatestBoard(fileKey);
    expect(persisted?.clusters[0]?.summary).toContain("Budget 999");
    expect(persisted?.nodes.find(node => node.id === "table")?.table?.cells[0]?.text).toBe("Budget 999");
    const context = await getBoardContext({ boardId: fileKey, nodeIds: ["Ttable;row;cell"] });
    expect(context.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "Ttable;row;cell", renderNodeId: "table", text: "Budget 999", sourceType: "table_cell" }),
    ]));
    const diff = await diffBoard({ boardId: fileKey, compareTo: 1 });
    expect(diff.stats).toMatchObject({ editedNodes: 1, modifiedClusters: 1 });
    expect(diff.tableCellChanges).toEqual([expect.objectContaining({ previousText: "Budget 100", currentText: "Budget 999" })]);
    expect(diff.baselineSnapshotId).toBe(before.snapshotId);
    expect(diff.currentSnapshotId).toBe(after.snapshotId);
  });

  it("upgrades only failed clusters on an identical ingest and preserves source history", async () => {
    activeTree = boardTree([imageNode("good", 0), imageNode("retry", 1000)]);
    let fail = true;
    visionMock.mockImplementation((cluster: Cluster, images: Buffer[], nodes: NormalizedNode[]) => {
      if (fail && cluster.nodeIds.includes("retry")) throw new Error("Temporary offline provider failure");
      return refine(cluster, images, nodes);
    });
    const before = await ingestBoard(input);
    expect(before.qualityReport).toMatchObject({ visionClusters: 1, incompleteClusters: 1, fallbackCount: 1 });
    fail = false;
    visionMock.mockClear();
    screenshotMock.mockClear();
    const after = await ingestBoard(input);
    expect(visionMock).toHaveBeenCalledTimes(1);
    expect((visionMock.mock.calls[0]?.[0] as Cluster).nodeIds).toEqual(["retry"]);
    expect(after.qualityReport).toMatchObject({ visionClusters: 2, incompleteClusters: 0, fallbackCount: 0, reusedClusters: 1 });
    expect(after.snapshotId).toBe(before.snapshotId);
    expect(await persistence.readBoardHistory(fileKey)).toHaveLength(1);
    expect(fileTreeMock).toHaveBeenCalledTimes(1);
    expect(metadataMock).toHaveBeenCalledTimes(1);
  });

  it("uses unchanged metadata without downloading the file or rerunning vision", async () => {
    const before = await ingestBoard(input);
    const after = await ingestBoard(input);
    expect(fileTreeMock).toHaveBeenCalledTimes(1);
    expect(metadataMock).toHaveBeenCalledTimes(1);
    expect(visionMock).toHaveBeenCalledTimes(1);
    expect(after.snapshotId).toBe(before.snapshotId);
    expect(after.qualityReport).toMatchObject({ cachedClusters: 1, visionClusters: 1, fallbackCount: 0 });
    expect((await persistence.readLatestBoard(fileKey))?.clusters[0]?.summarySource).toBe("vision_llm");
  });

  it("records a new capture time when a historical source state returns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const firstTime = Date.UTC(2026, 9, 9, 12);
    const changedTime = Date.UTC(2026, 9, 9, 13);
    const returnedTime = Date.UTC(2026, 9, 9, 14);
    vi.setSystemTime(firstTime);
    const first = await ingestBoard(input);
    vi.setSystemTime(changedTime);
    activeTree = boardTree([table("Budget 999")], "v2");
    await ingestBoard(input);
    vi.setSystemTime(returnedTime);
    activeTree = boardTree([table("Budget 100")], "v3");
    const returned = await ingestBoard(input);
    expect(returned.snapshotId).toBe(first.snapshotId);
    expect(visionMock).toHaveBeenCalledTimes(2);
    expect(returned.qualityReport?.cachedClusters).toBe(1);
    expect((await persistence.readLatestBoard(fileKey))?.createdAt).toBe(returnedTime);
    expect((await persistence.readBoardHistory(fileKey)).map(entry => entry.createdAt))
      .toEqual([firstTime, changedTime, returnedTime]);
    const diff = await diffBoard({ boardId: fileKey, compareTo: 1 });
    expect(diff.baselineCreatedAt).toBe(new Date(changedTime).toISOString());
    expect(diff.currentCreatedAt).toBe(new Date(returnedTime).toISOString());
    expect(diff.summaryText).toContain("changes from 2026-10-09T13:00:00Z to 2026-10-09T14:00:00Z");

    vi.setSystemTime(Date.UTC(2026, 9, 9, 15));
    await ingestBoard(input);
    expect((await persistence.readLatestBoard(fileKey))?.createdAt).toBe(returnedTime);
    expect((await persistence.readBoardHistory(fileKey)).map(entry => entry.createdAt))
      .toEqual([firstTime, changedTime, returnedTime]);
    expect(visionMock).toHaveBeenCalledTimes(2);
  });

  it("falls back from a missing metadata scope, but does not bypass rate limits", async () => {
    await ingestBoard(input);
    const { FigmaApiError } = await import("../src/lib/figmaApi.js");
    metadataMock.mockRejectedValueOnce(new FigmaApiError("Metadata access denied", 403));
    await ingestBoard(input);
    expect(fileTreeMock).toHaveBeenCalledTimes(2);
    expect(visionMock).toHaveBeenCalledTimes(1);
    metadataMock.mockRejectedValueOnce(new FigmaApiError("Rate limited", 429, 60));
    await expect(ingestBoard(input)).rejects.toThrow("Rate limited");
    expect(fileTreeMock).toHaveBeenCalledTimes(2);
  });

  it("keeps matching canvas coordinates on different pages in separate clusters", async () => {
    activeTree = boardTree([sticky("first", "Finding from page one")]);
    activeTree.document.children.push({ id: "other-page", name: "Other page", type: "CANVAS", children: [sticky("second", "Finding from page two")] });
    await ingestBoard({ ...input, ingestMode: "max_speed" });
    const persisted = await persistence.readLatestBoard(fileKey);
    expect(persisted?.clusters.map(cluster => cluster.nodeIds).sort()).toEqual([["first"], ["second"]]);
    expect(persisted?.nodes.find(node => node.id === "first")?.pageId).toBe("page");
    expect(persisted?.nodes.find(node => node.id === "second")?.pageId).toBe("other-page");
  });

  it("invalidates refinements after a provider change without creating a source change", async () => {
    const before = await ingestBoard(input);
    const firstBoard = await persistence.readLatestBoard(fileKey);
    vi.stubEnv("LLM_BASE_URL", "https://new-offline-provider.invalid/v1");
    const after = await ingestBoard(input);
    const secondBoard = await persistence.readLatestBoard(fileKey);
    expect(visionMock).toHaveBeenCalledTimes(2);
    expect(secondBoard?.refinementSignature).not.toBe(firstBoard?.refinementSignature);
    expect(secondBoard?.cacheKey).not.toBe(firstBoard?.cacheKey);
    expect(after.snapshotId).toBe(before.snapshotId);
    expect(await persistence.readBoardHistory(fileKey)).toHaveLength(1);
    expect(fileTreeMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an older prompt signature from the previous snapshot", async () => {
    const { flattenNodeTree } = await import("../src/lib/nodeTree.js");
    const { partitionedBoardClusters } = await import("../src/lib/spatialCluster.js");
    const nodes = flattenNodeTree(activeTree);
    const seeded: BoardData = {
      boardId: fileKey, fileKey, docStructureHint: "freeform", ingestMode: "max_quality",
      cacheKey: "previous-prompt-refinement", refinementSignature: "previous-prompt-version",
      figmaVersion: activeTree.version, nodes, connectorEdges: [], createdAt: 1,
      clusters: partitionedBoardClusters(nodes).map(cluster => ({ ...refine(cluster, [], nodes), summary: "Old prompt summary" })),
    };
    await persistence.persistBoard(seeded);
    const before = await persistence.readLatestBoard(fileKey);
    await ingestBoard(input);
    expect(visionMock).toHaveBeenCalledTimes(1);
    expect(fileTreeMock).not.toHaveBeenCalled();
    const after = await persistence.readLatestBoard(fileKey);
    expect(after?.snapshotId).toBe(before?.snapshotId);
    expect(after?.clusters[0]?.summary).toBe("Budget 100");
    expect(after?.refinementSignature).toBe(persistence.getRefinementSignature());
    expect(await persistence.readBoardHistory(fileKey)).toHaveLength(1);
  });

  it("retains late source facts and internal connector evidence through ingestion", async () => {
    activeTree = boardTree([
      ...Array.from({ length: 6 }, (_, index) => sticky(`note-${index}`, index === 5 ? "Launch code: ORCHID-742" : `Research finding ${index} with sufficient original planning details.`, index * 110)),
      { id: "edge", name: "Before", type: "CONNECTOR", characters: "must precede", connectorStart: { endpointNodeId: "note-4" }, connectorEnd: { endpointNodeId: "note-5" }, connectorStartStrokeCap: "NONE", connectorEndStrokeCap: "ARROW_LINES" },
    ]);
    await ingestBoard({ ...input, ingestMode: "balanced" });
    expect(visionMock).not.toHaveBeenCalled();
    const context = await getBoardContext({ boardId: fileKey, topic: "ORCHID-742" });
    expect(context.evidence.some(item => item.nodeId === "note-5" && item.text.includes("ORCHID-742"))).toBe(true);
    const details = await getBoardContext({ boardId: fileKey, nodeIds: ["note-4", "note-5"] });
    expect(details.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ connectorId: "edge", fromNodeId: "note-4", toNodeId: "note-5", label: "must precede" }),
    ]));
  });

  it("does not publish an aborted replacement to disk or memory", async () => {
    const initial = await ingestBoard(input);
    activeTree = boardTree([table("Budget 999")], "v2");
    const controller = new AbortController();
    await expect(ingestBoard(input, {
      signal: controller.signal,
      onProgress: phase => { if (phase === "persist") controller.abort(new Error("Cancelled before publishing")); },
    })).rejects.toThrow("Cancelled before publishing");
    expect((await persistence.readLatestBoard(fileKey))?.snapshotId).toBe(initial.snapshotId);
    expect(memory.getBoard(fileKey)?.snapshotId).toBe(initial.snapshotId);
    expect(await persistence.readBoardHistory(fileKey)).toHaveLength(1);
  });

  it("cancels an in-flight external request and leaves the committed snapshot intact", async () => {
    const initial = await ingestBoard(input);
    activeTree = boardTree([table("Budget 999")], "v2");
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let requestSignal: AbortSignal | undefined;
    screenshotMock.mockImplementation((_key: string, _nodes: string[], _token: string, signal: AbortSignal) => {
      requestSignal = signal;
      entered();
      return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const running = ingestBoard(input, { signal: controller.signal });
    const rejected = expect(running).rejects.toThrow("Stop this ingest");
    await started;
    controller.abort(new Error("Stop this ingest"));
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect((await persistence.readLatestBoard(fileKey))?.snapshotId).toBe(initial.snapshotId);
    expect(memory.getBoard(fileKey)?.snapshotId).toBe(initial.snapshotId);
    expect(visionMock).toHaveBeenCalledTimes(1);
  });
});
