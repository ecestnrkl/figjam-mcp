import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BoardData, Cluster, NormalizedNode, RefinedCluster } from "../src/types.js";
import { pngHeader } from "./fixtures/images.js";

const { fileTreeMock, metadataMock, screenshotMock, downloadMock, imageFillsMock, visionMock } = vi.hoisted(() => ({
  fileTreeMock: vi.fn(), metadataMock: vi.fn(), screenshotMock: vi.fn(), downloadMock: vi.fn(), imageFillsMock: vi.fn(), visionMock: vi.fn(),
}));
// Only the external boundaries are mocked. Normalization, hashes, clustering,
// source snapshots, refinement cache, history, context and diff run together.
vi.mock("../src/lib/figmaApi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/figmaApi.js")>()),
  fetchFileTree: fileTreeMock, fetchFileMetadata: metadataMock,
  fetchRenderUrls: screenshotMock, downloadRenders: downloadMock, fetchImageRefs: imageFillsMock,
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
  // Originals from image fills are the only downloads; every other network access fails.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (!String(url).startsWith("https://offline-originals.invalid/")) throw new Error("Unexpected network access in offline integration test");
    return new Response(pngHeader(100, 100, "offline-original"));
  }));
  activeTree = boardTree([table("Budget 100")]);
  fileTreeMock.mockImplementation(async () => activeTree);
  metadataMock.mockImplementation(async () => ({ version: activeTree.version }));
  screenshotMock.mockImplementation(async (_key: string, ids: string[]) => Object.fromEntries(ids.map(id => [id, `https://offline-images.invalid/${id}`])));
  downloadMock.mockImplementation(async (ids: string[]) => ids.map(() => pngHeader(100, 100, "offline-image")));
  imageFillsMock.mockImplementation(async () => new Proxy({}, { get: (_target, ref) => `https://offline-originals.invalid/${String(ref)}` }));
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
  it("re-extracts an unchanged legacy board and retains the original connector snapshot", async () => {
    activeTree = boardTree([sticky("idea", "Idea", 0), sticky("test", "Test", 1000),
      { id: "arrow", name: "Arrow", type: "CONNECTOR", connectorStart: { endpointNodeId: "idea" }, connectorEnd: { endpointNodeId: "test" }, connectorStartStrokeCap: "NONE", connectorEndStrokeCap: "LINE_ARROW" },
      { id: "canvas-anchor", name: "Anchor", type: "CONNECTOR", connectorStart: { endpointNodeId: "page" }, connectorEnd: { endpointNodeId: "page" }, connectorEndStrokeCap: "LINE_ARROW" },
    ]);
    const { flattenNodeTree } = await import("../src/lib/nodeTree.js");
    const { partitionedBoardClusters } = await import("../src/lib/spatialCluster.js");
    const nodes = flattenNodeTree(activeTree);
    const nodeHash = persistence.hashNormalizedNodes(nodes);
    const snapshotId = persistence.buildSnapshotId(fileKey, nodeHash, 4);
    const oldEdges = [
      { connectorId: "arrow", fromNodeId: "idea", toNodeId: "test", direction: "undirected" },
      { connectorId: "canvas-anchor", fromNodeId: "page", toNodeId: "page", direction: "undirected" },
    ];
    const derived = { boardId: fileKey, fileKey, docStructureHint: "freeform", ingestMode: "max_quality",
      cacheKey: "legacy-cache", schemaVersion: 4, snapshotId, nodeHash, figmaVersion: "v1", createdAt: 1,
      refinementSignature: "old-extraction-and-prompt", clusterRelations: [],
      clusters: partitionedBoardClusters(nodes).map(cluster => refine(cluster, [], nodes)) };
    const directory = path.join(cacheDirectory, "v4");
    await mkdir(directory);
    const source = JSON.stringify({ schemaVersion: 4, snapshotId, fileKey, nodes, connectorEdges: oldEdges });
    await writeFile(path.join(directory, `source-${snapshotId}.json`), source);
    await writeFile(path.join(directory, "refinement-legacy.json"), JSON.stringify({ schemaVersion: 4, revisionId: "legacy", snapshotId, derived }));
    await writeFile(path.join(directory, `board-${fileKey}.json`), JSON.stringify({ schemaVersion: 4,
      latest: "legacy-cache", latestRevision: "legacy", history: [{ cacheKey: "legacy-cache", refinementId: "legacy", snapshotId, nodeHash, createdAt: 1 }] }));
    expect((await persistence.readLatestBoard(fileKey))?.extractionVersion).toBe(4);
    const result = await ingestBoard(input);
    expect(metadataMock).not.toHaveBeenCalled();
    expect(fileTreeMock).toHaveBeenCalledTimes(1);
    expect(visionMock).toHaveBeenCalledTimes(2);
    expect(result.snapshotId).not.toBe(snapshotId);
    expect(result.relationCount).toBe(1);
    const { structuredContent: context } = await getBoardContext({ boardId: fileKey, nodeIds: ["idea", "test", "page"] });
    expect(context.connections).toEqual([expect.objectContaining({ connectorId: "arrow", fromNodeId: "idea", toNodeId: "test", direction: "forward", url: "https://www.figma.com/board/OfflineBoard?node-id=arrow" })]);
    const restored = await persistence.readLatestBoard(fileKey);
    expect(restored?.extractionVersion).toBe(6);
    expect(restored?.connectorEdges).toEqual([{ connectorId: "arrow", fromNodeId: "idea", toNodeId: "test", direction: "forward" }]);
    expect(await persistence.readBoardHistory(fileKey)).toHaveLength(2);
    expect((await persistence.readBoardSnapshot(fileKey, snapshotId))?.connectorEdges).toEqual(oldEdges);
    expect(await readFile(path.join(directory, `source-${snapshotId}.json`), "utf8")).toBe(source);
  });

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
    // The cell ID yields its row; row and column come from the cell ID.
    const { structuredContent: context } = await getBoardContext({ boardId: fileKey, nodeIds: ["Ttable;row;cell"] });
    expect(context.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "table", renderNodeId: "table", text: "Budget 999", sourceType: "table_row", row: 0 }),
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

  it("keeps interpretations through a forced ingest in every mode", async () => {
    activeTree = boardTree([imageNode("photo-a", 0), imageNode("photo-b", 1000), sticky("note", "Workshop note", 2000)]);
    const balanced = { ...input, ingestMode: "balanced" } as const;
    const first = await ingestBoard(balanced);
    expect(visionMock).toHaveBeenCalledTimes(2);
    const forcedSpeed = await ingestBoard({ ...balanced, ingestMode: "max_speed", forceFullIngest: true });
    expect(fileTreeMock).toHaveBeenCalledTimes(2);
    expect(forcedSpeed.qualityReport).toMatchObject({ visionClusters: 2, reusedClusters: 3, incompleteClusters: 0 });
    visionMock.mockClear();
    const forcedBalanced = await ingestBoard({ ...balanced, forceFullIngest: true });
    expect(fileTreeMock).toHaveBeenCalledTimes(3);
    expect(visionMock).not.toHaveBeenCalled();
    expect(forcedBalanced.qualityReport).toMatchObject({ visionClusters: 2, deterministicClusters: 1, reusedClusters: 3,
      incompleteClusters: 0, figmaRequests: { imageFills: 0, renders: 0 } });
    expect(forcedBalanced.summary).not.toContain("forceFullIngest");
    // An unchanged board keeps its snapshot, so diff_board sees no new state.
    expect(forcedBalanced.snapshotId).toBe(first.snapshotId);
    expect(await persistence.readBoardHistory(fileKey)).toHaveLength(1);
  });

  it.each(["balanced", "max_quality"] as const)("a forced %s ingest interprets only the pending cluster", async (ingestMode) => {
    activeTree = boardTree([imageNode("photo-a", 0), imageNode("photo-b", 1000), imageNode("photo-c", 2000)]);
    let fail = true;
    visionMock.mockImplementation((cluster: Cluster, images: Buffer[], nodes: NormalizedNode[]) => {
      // No retryAfter: the cluster is pending without a cooldown.
      if (fail && cluster.nodeIds.includes("photo-c")) throw new Error("Temporary offline provider failure");
      return refine(cluster, images, nodes);
    });
    const first = await ingestBoard({ ...input, ingestMode: "balanced" });
    expect(first.qualityReport).toMatchObject({ visionClusters: 2, incompleteClusters: 1 });
    fail = false;
    visionMock.mockClear();
    const forced = await ingestBoard({ ...input, ingestMode, forceFullIngest: true });
    expect(fileTreeMock).toHaveBeenCalledTimes(2);
    expect(metadataMock).not.toHaveBeenCalled();
    expect((visionMock.mock.calls as Array<[Cluster]>).map(([cluster]) => cluster.nodeIds)).toEqual([["photo-c"]]);
    expect(forced.qualityReport).toMatchObject({ visionClusters: 3, reusedClusters: 2, incompleteClusters: 0 });
    const saved = await persistence.readLatestBoard(fileKey);
    for (const id of ["photo-a", "photo-b"]) {
      expect(saved?.clusters.find(cluster => cluster.nodeIds.includes(id))).toMatchObject({ summarySource: "vision_llm", label: `Evidence ${id}` });
    }
  });

  it("reuses the interpretations of a focused ingest under the same cache key", async () => {
    activeTree = boardTree([imageNode("photo-a", 0), imageNode("photo-b", 1000), sticky("note", "Workshop note", 2000)]);
    const balanced = { ...input, ingestMode: "balanced" } as const;
    let fail = true;
    visionMock.mockImplementation((cluster: Cluster, images: Buffer[], nodes: NormalizedNode[]) => {
      if (fail && cluster.nodeIds.includes("photo-a")) throw new Error("Temporary offline provider failure");
      return refine(cluster, images, nodes);
    });
    const focused = await ingestBoard({ ...balanced, focusNodeIds: ["photo-b"] });
    expect(focused.qualityReport?.focus).toEqual({ requestedIds: ["photo-b"], foundIds: ["photo-b"], imageClusters: 1, interpreted: 1, pending: 0 });
    const focusedKey = (await persistence.readLatestBoard(fileKey))?.cacheKey;
    expect((await persistence.readLatestBoard(fileKey))?.qualityReport?.focus).toEqual(focused.qualityReport?.focus);
    fail = false;
    visionMock.mockClear();
    const unfocused = await ingestBoard(balanced);
    expect((visionMock.mock.calls as Array<[Cluster]>).map(([cluster]) => cluster.nodeIds)).toEqual([["photo-a"]]);
    expect(unfocused.qualityReport).toMatchObject({ visionClusters: 2, reusedClusters: 2, incompleteClusters: 0 });
    expect(unfocused.qualityReport?.focus).toBeUndefined();
    expect(unfocused.snapshotId).toBe(focused.snapshotId);
    expect((await persistence.readLatestBoard(fileKey))?.cacheKey).toBe(focusedKey);
  });

  it("keeps a vision summary of a text cluster through a forced balanced ingest", async () => {
    activeTree = boardTree([imageNode("photo", 0), sticky("note", "Workshop note", 2000)]);
    await ingestBoard(input);
    expect(visionMock).toHaveBeenCalledTimes(2);
    visionMock.mockClear();
    const forced = await ingestBoard({ ...input, ingestMode: "balanced", forceFullIngest: true });
    expect(visionMock).not.toHaveBeenCalled();
    expect(forced.qualityReport).toMatchObject({ visionClusters: 2, reusedClusters: 2 });
    const note = (await persistence.readLatestBoard(fileKey))?.clusters.find(cluster => cluster.nodeIds.includes("note"));
    expect(note).toMatchObject({ summarySource: "vision_llm", summary: "Workshop note" });
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

  it("honors an explicit phase deadline and starts no queued request after it expires", async () => {
    vi.stubEnv("INGEST_BOARD_VISION_BUDGET_MS", "25");
    vi.stubEnv("INGEST_BOARD_MIN_VISION_SLOT_MS", "0");
    vi.stubEnv("INGEST_BOARD_VISION_CONCURRENCY", "1");
    vi.resetModules();
    const { ingestBoard: configuredIngest } = await import("../src/tools/ingestBoard.js");
    vi.useFakeTimers();
    activeTree = boardTree([imageNode("first", 0), imageNode("queued", 1000)]);
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let requestSignal: AbortSignal | undefined;
    visionMock.mockImplementation((_cluster: Cluster, _images: Buffer[], _nodes: NormalizedNode[], signal: AbortSignal) => {
      requestSignal = signal;
      started();
      return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const running = configuredIngest(input);
    await entered;
    await vi.advanceTimersByTimeAsync(24);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const output = await running;
    expect(requestSignal?.aborted).toBe(true);
    expect(String(requestSignal?.reason)).toContain("25 ms");
    expect(imageFillsMock).toHaveBeenCalledTimes(1);
    expect(screenshotMock).not.toHaveBeenCalled();
    expect(visionMock).toHaveBeenCalledTimes(1);
    expect(output.qualityReport?.fallbackReasons).toEqual({ timeout: 1, time_budget: 1 });
  });

  it("preserves an explicit zero vision budget", async () => {
    vi.stubEnv("INGEST_BOARD_VISION_BUDGET_MS", "0");
    vi.resetModules();
    const { ingestBoard: configuredIngest } = await import("../src/tools/ingestBoard.js");
    const output = await configuredIngest(input);
    expect(screenshotMock).not.toHaveBeenCalled();
    expect(visionMock).not.toHaveBeenCalled();
    expect(output.qualityReport?.fallbackReasons).toEqual({ time_budget: 1 });
  });

  it("persists an ingest at the default budget end and continues deferred vision on the next ingest", async () => {
    vi.stubEnv("INGEST_BOARD_VISION_CONCURRENCY", "1");
    vi.resetModules();
    const { ingestBoard: configuredIngest } = await import("../src/tools/ingestBoard.js");
    activeTree = boardTree([imageNode("first", 0), imageNode("second", 1000)]);
    vi.useFakeTimers();
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    visionMock.mockImplementationOnce((cluster: Cluster, images: Buffer[], nodes: NormalizedNode[]) => {
      started();
      // Leaves 5 s of the 40 s budget, less than the 10 s minimum vision slot.
      return new Promise<RefinedCluster>(resolve => setTimeout(() => resolve(refine(cluster, images, nodes)), 35_000));
    });
    const running = configuredIngest(input);
    await entered;
    await vi.advanceTimersByTimeAsync(35_000);
    const first = await running;
    vi.useRealTimers();
    const interpretedId = (visionMock.mock.calls[0]?.[2] as NormalizedNode[])[0]!.id;
    const deferredId = interpretedId === "first" ? "second" : "first";

    expect(visionMock).toHaveBeenCalledTimes(1);
    expect(first.qualityReport).toMatchObject({ visionClusters: 1, incompleteClusters: 1, fallbackReasons: { time_budget: 1 } });
    expect(first.summary).toContain("Run ingest_board again to continue the remaining visual interpretation");
    const saved = await persistence.readLatestBoard(fileKey);
    expect(saved?.snapshotId).toBe(first.snapshotId);
    const savedCluster = (nodeId: string) => saved?.clusters.find(cluster => cluster.nodeIds.includes(nodeId));
    expect(savedCluster(interpretedId)).toMatchObject({ summarySource: "vision_llm" });
    expect(savedCluster(interpretedId)?.incomplete).toBeFalsy();
    expect(savedCluster(deferredId)).toMatchObject({ summarySource: "deterministic", incomplete: true, fallbackReason: "time_budget" });

    const second = await configuredIngest(input);
    expect(visionMock).toHaveBeenCalledTimes(2);
    expect((visionMock.mock.calls[1]?.[2] as NormalizedNode[]).map(node => node.id)).toEqual([deferredId]);
    expect(second.qualityReport).toMatchObject({ visionClusters: 2, incompleteClusters: 0, reusedClusters: 1 });
    expect(second.summary).not.toContain("Run ingest_board again");
  });

  describe("credential redaction of reused snapshot data", () => {
    // Synthetic value, assembled at runtime so secret scanners do not flag the test file.
    const secret = "Sommer" + "2024" + "!synthetic";
    const latestJson = async () => JSON.stringify(await persistence.readLatestBoard(fileKey));
    async function reloadIngest(env: Record<string, string>) {
      vi.unstubAllEnvs();
      vi.stubEnv("FIGJAM_MCP_CACHE_DIR", cacheDirectory);
      vi.stubEnv("FIGMA_ACCESS_TOKEN", "offline-test-only");
      vi.stubEnv("LLM_BASE_URL", "https://offline.invalid/v1");
      vi.stubEnv("LLM_API_KEY", "offline-test-only");
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      vi.resetModules();
      persistence = await import("../src/lib/persistentCache.js");
      return (await import("../src/tools/ingestBoard.js")).ingestBoard;
    }

    it("redacts unchanged nodes before deferred vision continues", async () => {
      activeTree = boardTree([sticky("login", `Passwort: ${secret}`, 0), imageNode("photo", 1000)]);
      const unredacted = await reloadIngest({ FIGJAM_MCP_REDACT_CREDENTIALS: "false", INGEST_BOARD_VISION_BUDGET_MS: "0" });
      const first = await unredacted(input);
      expect(first.qualityReport?.fallbackReasons).toEqual({ time_budget: 2 });
      expect(await latestJson()).toContain(secret);

      const redacted = await reloadIngest({});
      const second = await redacted(input);
      expect(fileTreeMock).toHaveBeenCalledTimes(1);
      expect(metadataMock).toHaveBeenCalledTimes(1);
      expect(visionMock).toHaveBeenCalledTimes(2);
      const visionNodes = visionMock.mock.calls.flatMap(call => call[2] as NormalizedNode[]);
      expect(visionNodes.find(node => node.id === "login")).toMatchObject({ name: "Sticky", text: "Passwort: [redacted]" });
      expect(JSON.stringify(visionNodes)).not.toContain(secret);
      expect(second.qualityReport).toMatchObject({ visionClusters: 2, incompleteClusters: 0 });
      expect(JSON.stringify(second)).not.toContain(secret);
      const saved = await latestJson();
      expect(saved).toContain("Passwort: [redacted]");
      expect(saved).not.toContain(secret);
    });

    it.each([
      ["a cache hit", false],
      ["reuse after a board change", true],
    ])("redacts reused vision labels and summaries on %s", async (_case, changeBoard) => {
      activeTree = boardTree([imageNode("photo", 0)]);
      visionMock.mockImplementationOnce((cluster: Cluster) => ({
        ...cluster, label: `Login PIN: ${secret}`, summary: `The photo shows Passwort: ${secret}`,
        confirmedNodeIds: [...cluster.nodeIds], summarySource: "vision_llm", modelId: "offline-vision",
      }));
      const unredacted = await reloadIngest({ FIGJAM_MCP_REDACT_CREDENTIALS: "false" });
      const first = await unredacted(input);
      expect(first.summary).toContain(secret);

      if (changeBoard) activeTree = boardTree([imageNode("photo", 0), sticky("note", "Unrelated workshop note", 5000)], "v2");
      const redacted = await reloadIngest({});
      const second = await redacted(input);
      expect(second.qualityReport).toMatchObject(changeBoard ? { reusedClusters: 1 } : { cachedClusters: 1 });
      expect(second.summary).toContain('"Login PIN: [redacted]"');
      expect(JSON.stringify(second)).not.toContain(secret);
      const saved = await persistence.readLatestBoard(fileKey);
      expect(saved?.clusters.find(cluster => cluster.nodeIds.includes("photo"))).toMatchObject({
        label: "Login PIN: [redacted]", summary: "The photo shows Passwort: [redacted]",
      });
      expect(JSON.stringify(saved)).not.toContain(secret);
    });

    it("keeps the snapshot of an already redacted board on an unchanged ingest", async () => {
      activeTree = boardTree([sticky("login", `Passwort: ${secret}`, 0), imageNode("photo", 1000)]);
      const before = await ingestBoard(input);
      const after = await ingestBoard(input);
      expect(after.snapshotId).toBe(before.snapshotId);
      expect(fileTreeMock).toHaveBeenCalledTimes(1);
      expect(visionMock).toHaveBeenCalledTimes(2);
      expect(after.qualityReport).toMatchObject({ cachedClusters: 2, visionClusters: 2, fallbackCount: 0 });
      expect(JSON.stringify(await persistence.readLatestBoard(fileKey))).not.toContain(secret);
    });
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

  it("keeps interpretations after a text model change and interprets again after a vision model change", async () => {
    activeTree = boardTree([imageNode("photo-a", 0), imageNode("photo-b", 1000), sticky("note", "Workshop note", 2000)]);
    const balanced = { ...input, ingestMode: "balanced" } as const;
    await ingestBoard(balanced);
    expect(visionMock).toHaveBeenCalledTimes(2);
    visionMock.mockClear();
    vi.stubEnv("LLM_TEXT_MODELS", "other/text-model");
    vi.stubEnv("LLM_FAST_TEXT_MODELS", "other/fast-model");
    const textChanged = await ingestBoard(balanced);
    expect(visionMock).not.toHaveBeenCalled();
    expect(textChanged.qualityReport).toMatchObject({ visionClusters: 2, incompleteClusters: 0 });
    vi.stubEnv("LLM_VISION_MODELS", "other/vision-model");
    const visionChanged = await ingestBoard(balanced);
    expect((visionMock.mock.calls as Array<[Cluster]>).map(([cluster]) => cluster.nodeIds).sort()).toEqual([["photo-a"], ["photo-b"]]);
    expect(visionChanged.qualityReport).toMatchObject({ visionClusters: 2, reusedClusters: 0 });
  });

  it("retains late source facts and internal connector evidence through ingestion", async () => {
    activeTree = boardTree([
      ...Array.from({ length: 6 }, (_, index) => sticky(`note-${index}`, index === 5 ? "Launch code: ORCHID-742" : `Research finding ${index} with sufficient original planning details.`, index * 110)),
      { id: "edge", name: "Before", type: "CONNECTOR", characters: "must precede", connectorStart: { endpointNodeId: "note-4" }, connectorEnd: { endpointNodeId: "note-5" }, connectorStartStrokeCap: "NONE", connectorEndStrokeCap: "ARROW_LINES" },
    ]);
    await ingestBoard({ ...input, ingestMode: "balanced" });
    expect(visionMock).not.toHaveBeenCalled();
    const { structuredContent: context } = await getBoardContext({ boardId: fileKey, topic: "ORCHID-742" });
    expect(context.evidence.some(item => item.nodeId === "note-5" && item.text.includes("ORCHID-742"))).toBe(true);
    const { structuredContent: details } = await getBoardContext({ boardId: fileKey, nodeIds: ["note-4", "note-5"] });
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

describe("deterministic cluster labels", () => {
  const speed = { ...input, ingestMode: "max_speed" } as const;
  const note = (id: string, text: string, x: number, y: number) =>
    ({ id, name: "Sticky", type: "STICKY", characters: text, absoluteBoundingBox: { x, y, width: 100, height: 100 } });
  const section = (id: string, name: string, children: unknown[]) =>
    ({ id, name, type: "SECTION", absoluteBoundingBox: { x: 0, y: 0, width: 8000, height: 8000 }, children });
  const longName = "Feedback from the pilot interviews in October";
  // Every pair is listed bottom first, so member order differs from reading order.
  const labelBoard = (lowerNote = "Lower note", version = "v1") => boardTree([
    section("ideas", "3 · Ideas", [note("idea-low", "Pickup shelf with name labels", 0, 150), note("idea-top", "Order ahead", 150, 0)]),
    section("feedback", longName, [
      note("fb-low", "Slow checkout", 0, 150), note("fb-top", "Clear menu", 0, 0),
      note("fb-far-low", "Late food", 3000, 150), note("fb-far-top", "Wi-Fi drops", 3000, 0),
    ]),
    section("unnamed", "  ", [note("u-low", "Beta", 0, 150), note("u-top", "Alpha", 0, 0)]),
    section("solo", "Solo", [note("solo-note", "Only note", 0, 0)]),
    note("out-low", lowerNote, 6000, 150), note("out-top", "Upper note", 6000, 0),
  ], version);
  const labelOf = async (nodeId: string) =>
    (await persistence.readLatestBoard(fileKey))?.clusters.find(cluster => cluster.nodeIds.includes(nodeId))?.label;
  const expected = {
    "idea-top": "3 · Ideas", "fb-top": "Feedback from the pilot interviews in...: Clear menu",
    "fb-far-top": "Feedback from the pilot interviews in...: Wi-Fi drops", "u-top": "Alpha", "solo-note": "Only note",
    "out-top": "Upper note",
  };
  const expectLabels = async (labels: Record<string, string>) => {
    for (const [nodeId, label] of Object.entries(labels)) expect(await labelOf(nodeId), nodeId).toBe(label);
  };
  /** Gives every persisted cluster the label, and optionally the phase, an older version would have stored. */
  async function ageLabels(phase?: string): Promise<void> {
    for (const file of await readdir(cacheDirectory, { recursive: true })) {
      if (!/refinement-[^/\\]+\.json$/.test(file)) continue;
      const envelope = JSON.parse(await readFile(path.join(cacheDirectory, file), "utf8"));
      for (const cluster of envelope.derived.clusters) Object.assign(cluster, { label: "Old label" }, phase ? { phase } : {});
      await writeFile(path.join(cacheDirectory, file), JSON.stringify(envelope));
    }
  }

  it("names clusters after their section, else after their first text in reading order", async () => {
    activeTree = labelBoard();
    const result = await ingestBoard(speed);
    expect(result.clusterCount).toBe(6);
    await expectLabels(expected);
  });

  it("relabels deterministic clusters loaded from the cache or reused after a change", async () => {
    activeTree = labelBoard();
    await ingestBoard(speed);
    await ageLabels();
    const cached = await ingestBoard(speed);
    expect(cached.qualityReport).toMatchObject({ cachedClusters: 6 });
    expect(fileTreeMock).toHaveBeenCalledTimes(1);
    await expectLabels(expected);

    await ageLabels();
    activeTree = labelBoard("Edited lower note", "v2");
    const reused = await ingestBoard(speed);
    expect(reused.qualityReport).toMatchObject({ reusedClusters: 5 });
    await expectLabels(expected);
  });

  it("maps the phases of an unchanged board from the cache after relabeling, as a full ingest does", async () => {
    const diamond = { ...speed, docStructureHint: "double_diamond" } as const;
    activeTree = boardTree([
      section("research", "Research", [note("r-1", "Note A", 0, 0), note("r-2", "Note B", 0, 150)]),
      section("synthesis", "Synthesis", [note("s-1", "Note C", 0, 0), note("s-2", "Note D", 0, 150)]),
    ]);
    await ingestBoard(diamond);
    const phases = async () => Object.fromEntries((await persistence.readLatestBoard(fileKey))!.clusters.map(cluster => [cluster.label, cluster.phase]));
    const full = await phases();
    expect(full).toEqual({ Research: "discover", Synthesis: "define" });
    await ageLabels("deliver");
    expect((await ingestBoard(diamond)).qualityReport).toMatchObject({ cachedClusters: 2 });
    expect(fileTreeMock).toHaveBeenCalledTimes(1);
    expect(await phases()).toEqual(full);
  });

  it("keeps model labels on cached and reused clusters", async () => {
    activeTree = labelBoard();
    await ingestBoard(input);
    await expectLabels({ "idea-top": "Evidence idea-low", "fb-top": "Evidence fb-low" });
    expect((await ingestBoard(input)).qualityReport).toMatchObject({ cachedClusters: 6 });
    activeTree = labelBoard("Edited lower note", "v2");
    expect((await ingestBoard(speed)).qualityReport).toMatchObject({ reusedClusters: 5 });
    await expectLabels({ "idea-top": "Evidence idea-low", "fb-top": "Evidence fb-low", "out-top": "Upper note" });
  });
});

describe("arrows from either end", () => {
  const speed = { ...input, ingestMode: "max_speed" } as const;
  const note = (id: string, text: string, x: number) =>
    ({ id, name: "Sticky", type: "STICKY", characters: text, absoluteBoundingBox: { x, y: 0, width: 100, height: 100 } });
  const section = (id: string, name: string, x: number, children: unknown[]) =>
    ({ id, name, type: "SECTION", absoluteBoundingBox: { x, y: 0, width: 1000, height: 1000 }, children });
  const arrow = (id: string, text: string, from: string, to: string) => ({ id, name: text, type: "CONNECTOR", characters: text,
    connectorStart: { endpointNodeId: from }, connectorEnd: { endpointNodeId: to }, connectorStartStrokeCap: "NONE", connectorEndStrokeCap: "ARROW_LINES" });
  const arrowBoard = () => boardTree([
    section("pain", "Pain points", 0, [note("queue", "Long queues at peak times", 0)]),
    section("ideas", "Ideas", 3000, [note("order", "Order ahead with a pickup time slot", 3000), note("wifi", "Guest Wi-Fi password: CampusCafe2026", 3150)]),
    arrow("solves", "solves", "queue", "order"),
    arrow("needs", "needs", "queue", "wifi"),
  ]);

  it("keeps an arrow's label on the arrow instead of a loose excerpt", async () => {
    activeTree = arrowBoard();
    await ingestBoard(speed);
    const { structuredContent: overview } = await getBoardContext({ boardId: fileKey });
    expect(overview.evidence.map(item => item.nodeId).sort()).toEqual(["order", "queue", "wifi"]);
    expect(overview.evidence.some(item => item.text === "solves" || item.text === "needs")).toBe(false);
    expect(overview.connections.find(item => item.connectorId === "solves")).toMatchObject({ label: "solves" });
    expect(overview.relations).toEqual([expect.objectContaining({ label: "solves, needs", edgeCount: 2 })]);
    expect((await getBoardContext({ boardId: fileKey, outsideSections: true })).structuredContent.totalMatched).toBe(0);
  });

  it("shows an arrow with one end on the page and names the other end", async () => {
    activeTree = arrowBoard();
    await ingestBoard(speed);
    const { text, structuredContent: pain } = await getBoardContext({ boardId: fileKey, nodeIds: ["pain"] });
    expect(pain.evidence.map(item => item.nodeId)).toEqual(["queue"]);
    expect(pain.connections).toEqual([
      expect.objectContaining({ connectorId: "solves", fromNodeId: "queue", toNodeId: "order", toText: "Order ahead with a pickup time slot", label: "solves" }),
      expect.objectContaining({ connectorId: "needs", toNodeId: "wifi", toText: "Guest Wi-Fi password: [redacted]" }),
    ]);
    expect(pain.connections.some(item => "fromText" in item)).toBe(false);
    expect(text).toContain("- queue → order «Order ahead with a pickup time slot» (solves)");
    expect(JSON.stringify(pain) + text).not.toContain("CampusCafe2026");

    const { structuredContent: both } = await getBoardContext({ boardId: fileKey, nodeIds: ["pain", "ideas"] });
    expect(both.connections.map(item => item.connectorId).sort()).toEqual(["needs", "solves"]);
    expect(both.connections.some(item => "fromText" in item || "toText" in item)).toBe(false);

    const { structuredContent: ideas } = await getBoardContext({ boardId: fileKey, nodeIds: ["ideas"] });
    expect(ideas.connections.find(item => item.connectorId === "solves")).toMatchObject({ fromText: "Long queues at peak times" });
    expect(ideas.connections.find(item => item.connectorId === "solves")).not.toHaveProperty("toText");
  });
});
