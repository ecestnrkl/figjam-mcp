import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardData, Cluster, NormalizedNode } from "../src/types.js";
import { FigmaApiError, FigmaDownloadBudgetError, FigmaTimeoutError } from "../src/lib/figmaApi.js";
import { LLMConfigurationError, LlmInvalidJsonError, LlmRequestError, LlmTimeoutError } from "../src/lib/llmClient.js";
import { cornerColours, gifHeader, jpegHeader, markedJpeg, pngHeader, syntheticJpeg, syntheticPng, withOrientation } from "./fixtures/images.js";

const {
  fetchFileTreeMock,
  fetchRenderUrlsMock,
  downloadRendersMock,
  fetchImageRefsMock,
  downloadFetchMock,
  refineClusterWithVisionMock,
  readCachedBoardMock,
  persistBoardMock,
  readLatestBoardMock,
  resizeInWorkerMock,
  fakeHashClusterNodes,
} = vi.hoisted(() => ({
  fetchFileTreeMock: vi.fn(),
  fetchRenderUrlsMock: vi.fn(),
  downloadRendersMock: vi.fn(),
  fetchImageRefsMock: vi.fn(),
  downloadFetchMock: vi.fn(),
  refineClusterWithVisionMock: vi.fn(),
  readCachedBoardMock: vi.fn(),
  persistBoardMock: vi.fn(),
  readLatestBoardMock: vi.fn(),
  resizeInWorkerMock: vi.fn(),
  // Deterministic stand-in with the same semantics as the real hash:
  // id + text + imageRef, order-independent.
  fakeHashClusterNodes: (nodes: Array<{ id: string; text?: string; imageRef?: string }>) =>
    JSON.stringify(
      nodes.map((n) => [n.id, n.text?.trim() ?? "", n.imageRef ?? ""]).sort(),
    ),
}));

vi.mock("../src/lib/figmaApi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/figmaApi.js")>()),
  fetchFileTree: fetchFileTreeMock,
  fetchRenderUrls: fetchRenderUrlsMock,
  downloadRenders: downloadRendersMock,
  fetchImageRefs: fetchImageRefsMock,
}));

vi.mock("../src/lib/visionInterpreter.js", () => ({
  refineClusterWithVision: refineClusterWithVisionMock,
}));

// The worker thread runs only from the built package (see package:smoke); here the same function runs inline.
vi.mock("../src/lib/imageWorker.js", () => ({ resizeInWorker: resizeInWorkerMock }));

vi.mock("../src/lib/persistentCache.js", () => ({
  EXTRACTION_VERSION: 5,
  extractFigmaLastModified: () => "2026-07-04T00:00:00Z",
  hashNormalizedNodes: () => "node-hash",
  hashClusterNodes: fakeHashClusterNodes,
  buildBoardCacheKey: () => "cache-key",
  readCachedBoard: readCachedBoardMock,
  persistBoard: persistBoardMock,
  getRefinementSignature: () => "current-refinement",
  buildSnapshotId: () => "snapshot-id",
  readLatestBoard: readLatestBoardMock,
}));

const { flattenNodeTree } = await import("../src/lib/nodeTree.js");
const { partitionedBoardClusters } = await import("../src/lib/spatialCluster.js");
const { ingestBoard, parseFigmaFileKey } = await import("../src/tools/ingestBoard.js");
const { getBoardContext } = await import("../src/tools/getBoardContext.js");
const { getBoard } = await import("../src/lib/cache.js");
const { redactBoard } = await import("../src/lib/redact.js");
const { hasEvidenceIndex } = await import("../src/lib/evidence.js");
const { imageSize, resizeToJpeg } = await import("../src/lib/imageResize.js");

/** A 100 px JPEG original whose bytes name its URL, so tests can check which cluster receives it. */
function jpeg(tag: string, size = 0): Buffer {
  return jpegHeader(100, 100, tag, size);
}
/** A 100 px render whose bytes name its URL. */
function render(url: string): Buffer {
  return pngHeader(100, 100, url);
}
function imageResponse(body: Buffer, contentLength: number | undefined = body.length): Response {
  return new Response(body, { headers: contentLength === undefined ? {} : { "Content-Length": String(contentLength) } });
}
const MiB = 1024 * 1024;

function rawTree() {
  return {
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [
        {
          id: "0:1",
          name: "Page",
          type: "CANVAS",
          children: [
            {
              id: "1:1",
              name: "Research sticky",
              type: "STICKY",
              absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
              characters:
                "This text-rich cluster already contains enough extracted research notes.",
            },
            {
              id: "1:2",
              name: "Screenshot",
              type: "SHAPE_WITH_TEXT",
              absoluteBoundingBox: { x: 1000, y: 0, width: 100, height: 100 },
              fills: [{ type: "IMAGE", imageRef: "image-ref" }],
            },
            {
              id: "1:3",
              name: "Connector",
              type: "CONNECTOR",
              absoluteBoundingBox: { x: 100, y: 40, width: 900, height: 20 },
              characters: "leads to",
              connectorStart: { endpointNodeId: "1:1" },
              connectorEnd: { endpointNodeId: "1:2" },
            },
          ],
        },
      ],
    },
  };
}

/** rawTree with a drawing instead of the image: its cluster is rendered, not read from image fills. */
function drawingTree() {
  const tree = rawTree();
  delete (tree.document.children[0]!.children[1] as { fills?: unknown }).fills;
  return tree;
}

function visionPriorityTree() {
  return {
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [
        {
          id: "0:1",
          name: "Page",
          type: "CANVAS",
          children: [
            {
              id: "1:1",
              name: "Text-rich first on canvas",
              type: "STICKY",
              absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
              characters: "A detailed research note that already explains the cluster in text.",
            },
            {
              id: "1:2",
              name: "No extracted text",
              type: "SHAPE_WITH_TEXT",
              absoluteBoundingBox: { x: 1000, y: 0, width: 100, height: 100 },
            },
            {
              id: "1:3",
              name: "Image last on canvas",
              type: "SHAPE_WITH_TEXT",
              absoluteBoundingBox: { x: 2000, y: 0, width: 100, height: 100 },
              fills: [{ type: "IMAGE", imageRef: "priority-image-ref" }],
            },
          ],
        },
      ],
    },
  };
}

function cachedBoard(): BoardData {
  return {
    extractionVersion: 5,
    boardId: "AbC123",
    fileKey: "AbC123",
    docStructureHint: "freeform",
    ingestMode: "balanced",
    nodes: flattenNodeTree(rawTree()),
    cacheKey: "cache-key",
    snapshotId: "snapshot-id",
    refinementSignature: "current-refinement",
    clusters: partitionedBoardClusters(flattenNodeTree(rawTree())).map((cluster) => ({
      ...cluster,
      label: `Cached ${cluster.nodeIds[0]}`,
      summary: "Cached summary.",
      confirmedNodeIds: [...cluster.nodeIds],
      summarySource: "vision_llm" as const,
      incomplete: false,
    })),
    createdAt: 1,
  };
}

beforeEach(() => {
  process.env.FIGMA_ACCESS_TOKEN = "token";
  vi.stubEnv("LLM_BASE_URL", "https://offline.invalid/v1");
  vi.stubEnv("LLM_API_KEY", "offline-test-only");
  fetchFileTreeMock.mockResolvedValue(rawTree());
  fetchRenderUrlsMock.mockImplementation(async (_key: string, ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, `https://cdn.example/${id}`])));
  // Each image carries its render URL, so tests can check which cluster receives it.
  downloadRendersMock.mockImplementation(async (ids: string[], urls: Record<string, string>) =>
    ids.map(id => render(urls[id]!)));
  // Every imageRef has an original; originals download through the real downloadOriginals.
  fetchImageRefsMock.mockImplementation(async () => new Proxy({}, { get: (_target, ref) => `https://originals.example/${String(ref)}` }));
  downloadFetchMock.mockImplementation(async (url: string) => imageResponse(jpeg(url)));
  vi.stubGlobal("fetch", downloadFetchMock);
  resizeInWorkerMock.mockImplementation(async (data: Uint8Array, format: "image/png" | "image/jpeg") => resizeToJpeg(data, format));
  refineClusterWithVisionMock.mockImplementation(
    async (cluster: Cluster, _screenshots: Buffer[], _nodes: NormalizedNode[]) => ({
      ...cluster,
      label: `Vision ${cluster.id}`,
      summary: "Vision summary.",
      confirmedNodeIds: [...cluster.nodeIds],
      summarySource: "vision_llm",
      modelId: "vision-model",
    }),
  );
  readCachedBoardMock.mockResolvedValue(undefined);
  persistBoardMock.mockResolvedValue(undefined);
  readLatestBoardMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete process.env.FIGMA_ACCESS_TOKEN;
});

describe("ingestBoard", () => {
  it("parses only canonical Figma hosts and paths", () => {
    expect(
      parseFigmaFileKey("  https://workspace.figma.com/board/AbC123/Test?node-id=1-2  "),
    ).toBe("AbC123");
    expect(() =>
      parseFigmaFileKey("https://example.com/path/figma.com/board/AbC123/Test"),
    ).toThrow(/Invalid Figma URL/);
    expect(() =>
      parseFigmaFileKey("https://figma.com.evil.example/board/AbC123/Test"),
    ).toThrow(/Invalid Figma URL/);
  });

  it("trims an explicit Figma token before using it", async () => {
    await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      figmaAccessToken: "  explicit-token  ",
      docStructureHint: "freeform",
      ingestMode: "max_speed",
    });

    expect(fetchFileTreeMock).toHaveBeenCalledWith("AbC123", "explicit-token", undefined);
  });

  it("trims the Figma token read from the environment", async () => {
    process.env.FIGMA_ACCESS_TOKEN = "  environment-token  ";

    await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_speed",
    });

    expect(fetchFileTreeMock).toHaveBeenCalledWith("AbC123", "environment-token", undefined);
  });

  it("balanced mode uses vision only for image clusters and clusters without text", async () => {
    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "balanced",
    });

    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(1);
    expect(output.qualityReport).toMatchObject({
      deterministicClusters: 1,
      visionClusters: 1,
      fallbackCount: 0,
    });
  });

  function mixedClusterTree() {
    const tree = rawTree();
    tree.document.children[0]!.children = [
      { id: "label:1", name: "Ideas", type: "TEXT", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 }, characters: "Ideas" },
      { id: "image:1", name: "Image", type: "SHAPE_WITH_TEXT", absoluteBoundingBox: { x: 1000, y: 0, width: 100, height: 100 },
        fills: [{ type: "IMAGE", imageRef: "image-ref" }] },
      { id: "vector:1", name: "Vector", type: "VECTOR", absoluteBoundingBox: { x: 2000, y: 0, width: 100, height: 100 } },
      { id: "vector:2", name: "Vector", type: "VECTOR", absoluteBoundingBox: { x: 2110, y: 0, width: 100, height: 100 } },
    ] as typeof tree.document.children[0]["children"];
    return tree;
  }

  it("balanced mode leaves short text labels to their text and interprets images and drawings", async () => {
    fetchFileTreeMock.mockResolvedValue(mixedClusterTree());
    const balanced = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "balanced" });
    const visionNodes = refineClusterWithVisionMock.mock.calls.map(call => (call[0] as Cluster).nodeIds).sort();
    expect(visionNodes).toEqual([["image:1"], ["vector:1", "vector:2"]]);
    expect(balanced.qualityReport).toMatchObject({ visionClusters: 2, deterministicClusters: 1, incompleteClusters: 0 });
    const label = (persistBoardMock.mock.calls[0]?.[0] as BoardData).clusters.find(cluster => cluster.nodeIds.includes("label:1"))!;
    expect(label).toMatchObject({ summarySource: "deterministic" });
    expect(label.incomplete).toBeFalsy();

    refineClusterWithVisionMock.mockClear();
    const quality = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "max_quality", forceFullIngest: true });
    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(3);
    expect(quality.qualityReport?.visionClusters).toBe(3);
  });

  it("completes a previously pending text label without a request and keeps existing vision summaries", async () => {
    const tree = mixedClusterTree();
    const nodes = flattenNodeTree(tree);
    const previous: BoardData = { ...cachedBoard(), nodes,
      clusters: partitionedBoardClusters(nodes).map(cluster => cluster.nodeIds.includes("label:1")
        ? { ...cluster, label: "Ideas", summary: "Pending.", confirmedNodeIds: cluster.nodeIds,
          summarySource: "deterministic" as const, incomplete: true, fallbackReason: "time_budget" }
        : { ...cluster, label: "Earlier vision", summary: "Earlier vision summary.", confirmedNodeIds: cluster.nodeIds,
          summarySource: "vision_llm" as const, modelId: "vision-model", incomplete: false }) };
    fetchFileTreeMock.mockResolvedValueOnce(tree);
    readLatestBoardMock.mockResolvedValueOnce(previous);
    const output = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "balanced" });
    expect(fetchRenderUrlsMock).not.toHaveBeenCalled();
    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(output.qualityReport).toMatchObject({ incompleteClusters: 0, visionClusters: 2, deterministicClusters: 1 });
    const persisted = persistBoardMock.mock.calls[0]?.[0] as BoardData;
    const label = persisted.clusters.find(cluster => cluster.nodeIds.includes("label:1"))!;
    expect(label.incomplete).toBeFalsy();
    expect(label.fallbackReason).toBeUndefined();
    expect(persisted.clusters.filter(cluster => cluster.summarySource === "vision_llm").map(cluster => cluster.summary))
      .toEqual(["Earlier vision summary.", "Earlier vision summary."]);
  });

  it("max_speed mode skips vision", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_speed",
    });

    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(fetchRenderUrlsMock).not.toHaveBeenCalled();
    expect(output.qualityReport?.deterministicClusters).toBe(2);
    expect(output.ingestMode).toBe("max_speed");
    expect(output.summary).toContain("ingestMode=max_speed");
    const persisted = persistBoardMock.mock.calls[0]?.[0] as BoardData;
    expect(persisted.clusters.some(cluster => cluster.summary.includes("timeout-safe"))).toBe(false);
  });

  it("reports missing model configuration before requesting any screenshots", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    const output = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "balanced" });
    expect(fetchRenderUrlsMock).not.toHaveBeenCalled();
    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(output.qualityReport).toMatchObject({ fallbackCount: 1, fallbackReasons: { config: 1 } });
    expect(output.summary).toContain("Original extracted texts, tables and node references remain available");
    expect(output.summary).toContain("diagnose_llm_config");
    expect(output.summary).not.toContain("timed out");
    expect(output.summary).toContain("the model settings are missing or invalid (1 cluster)");
    expect(output.summary).toContain('LLM_API_KEY is not set. Add it to "env" of this server in your MCP client configuration');
    expect(output.summary).toContain("then restart the server");
  });

  it("does not carry an old vision cooldown into intentional max_speed processing", async () => {
    const previous = cachedBoard();
    previous.clusters = previous.clusters.map(cluster => ({ ...cluster, summarySource: "deterministic",
      incomplete: true, fallbackReason: "rate_limit", retryAfter: Date.now() + 60_000 }));
    readLatestBoardMock.mockResolvedValueOnce(previous);
    const output = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "max_speed" });
    expect(fetchRenderUrlsMock).not.toHaveBeenCalled();
    expect(output.qualityReport).toMatchObject({ fallbackCount: 0, incompleteClusters: 0, fallbackReasons: {} });
    const persisted = persistBoardMock.mock.calls[0]?.[0] as BoardData;
    expect(persisted.clusters.every(cluster => !cluster.incomplete && cluster.retryAfter === undefined)).toBe(true);
  });

  it("does not invent detailed causes for older cached failures", async () => {
    const previous = cachedBoard();
    previous.clusters = previous.clusters.map(cluster => cluster.nodeIds.includes("1:2")
      ? { ...cluster, summarySource: "deterministic", incomplete: true,
        fallbackReason: "vision_failed", retryAfter: Date.now() + 60_000 }
      : cluster);
    readLatestBoardMock.mockResolvedValueOnce(previous);
    const output = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "balanced" });
    expect(fetchRenderUrlsMock).not.toHaveBeenCalled();
    expect(output.qualityReport?.fallbackReasons).toEqual({ vision_failed: 1 });
    expect(output.summary).toContain("an earlier run failed (cause not recorded) (1 cluster)");
  });

  it.each([
    ["render", new Error("private provider body"), "render_failed"],
    ["download", new Error("private provider body"), "render_failed"],
    ["model", new Error("private provider body"), "model_failed"],
    ["render", new FigmaTimeoutError("private provider body"), "timeout"],
    ["download", new FigmaTimeoutError("private provider body"), "timeout"],
    ["model", new LlmTimeoutError("private provider body"), "timeout"],
    ["model", new LLMConfigurationError("private provider body"), "config"],
    ["model", new LlmRequestError("private provider body", 401), "auth"],
    ["render", new FigmaApiError("private provider body", 403), "auth"],
    ["render", new FigmaApiError("private provider body", 429), "rate_limit"],
    ["model", new LlmRequestError("private provider body", 429), "rate_limit"],
    ["model", new LlmInvalidJsonError("private provider body", "private reply text"), "invalid_reply"],
    ["download", new FigmaDownloadBudgetError(), "download_budget"],
  ] as const)("classifies %s failure without exposing provider text (case %#)", async (stage, error, reason) => {
    fetchFileTreeMock.mockResolvedValueOnce(drawingTree());
    ({ render: fetchRenderUrlsMock, download: downloadRendersMock, model: refineClusterWithVisionMock })[stage].mockRejectedValueOnce(error);
    const output = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "balanced" });
    expect(output.qualityReport?.fallbackReasons).toEqual({ [reason]: 1 });
    const serialized = JSON.stringify([output, persistBoardMock.mock.calls[0]?.[0]]);
    expect(serialized).not.toContain("private provider body");
    expect(serialized).not.toContain("private reply text");
  });

  it("stops scheduling new work after a provider rate limit and records the cooldown", async () => {
    const tree = rawTree();
    tree.document.children[0]!.children = Array.from({ length: 8 }, (_, index) => ({
      id: `image:${index}`, name: "Image", type: "SHAPE_WITH_TEXT",
      absoluteBoundingBox: { x: index * 1000, y: 0, width: 100, height: 100 },
      fills: [{ type: "IMAGE", imageRef: `image-${index}` }],
    }));
    fetchFileTreeMock.mockResolvedValueOnce(tree);
    refineClusterWithVisionMock.mockRejectedValue(new LlmRequestError("private provider body", 429, 90));
    const before = Date.now();
    const output = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "balanced" });
    expect(fetchImageRefsMock).toHaveBeenCalledTimes(1);
    expect(fetchRenderUrlsMock).not.toHaveBeenCalled();
    expect(downloadFetchMock).toHaveBeenCalledTimes(3);
    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(3);
    expect(output.qualityReport?.fallbackReasons).toEqual({ rate_limit: 8 });
    expect(output.qualityReport?.nextRetryAt).toBeGreaterThanOrEqual(before + 90_000);
    expect(output.summary).toContain("Retry after");
  });

  function imageClusterTree(count: number) {
    const tree = rawTree();
    tree.document.children[0]!.children = Array.from({ length: count }, (_, index) => ({
      id: `image:${index}`, name: "Image", type: "SHAPE_WITH_TEXT",
      absoluteBoundingBox: { x: index * 1000, y: 0, width: 100, height: 100 },
      fills: [{ type: "IMAGE", imageRef: `image-${index}` }],
    }));
    return tree;
  }

  /** Clusters of drawings without text and without images, which are rendered. */
  function drawingClusterTree(count: number) {
    const tree = rawTree();
    tree.document.children[0]!.children = Array.from({ length: count }, (_, index) => ({
      id: `drawing:${index}`, name: "Drawing", type: "SHAPE_WITH_TEXT",
      absoluteBoundingBox: { x: index * 1000, y: 0, width: 100, height: 100 },
    })) as typeof tree.document.children[0]["children"];
    return tree;
  }

  it("renders the screenshots of many vision clusters in few requests and hands each cluster its own images", async () => {
    fetchFileTreeMock.mockResolvedValueOnce(drawingClusterTree(25));
    const output = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "balanced" });
    // 3 workers × 40 s / 10 s slot = 12 planned clusters share the first request;
    // the rest is rendered in a second request once the workers reach it.
    expect(fetchRenderUrlsMock).toHaveBeenCalledTimes(2);
    expect(fetchRenderUrlsMock.mock.calls.map(call => (call[1] as string[]).length)).toEqual([12, 13]);
    expect(fetchRenderUrlsMock.mock.calls.flatMap(call => call[1] as string[]).sort())
      .toEqual(Array.from({ length: 25 }, (_, index) => `drawing:${index}`).sort());
    expect(downloadRendersMock).toHaveBeenCalledTimes(25);
    for (const [cluster, screenshots] of refineClusterWithVisionMock.mock.calls as Array<[Cluster, Buffer[]]>) {
      expect(screenshots).toEqual(cluster.nodeIds.map(id => render(`https://cdn.example/${id}`)));
    }
    expect(output.qualityReport).toMatchObject({ visionClusters: 25, fallbackCount: 0 });
  });

  it("renders clusters beyond the planned budget only when the workers reach them", async () => {
    fetchFileTreeMock.mockResolvedValueOnce(drawingClusterTree(12));
    vi.stubEnv("INGEST_BOARD_VISION_CONCURRENCY", "1");
    vi.resetModules();
    const { ingestBoard: configuredIngest } = await import("../src/tools/ingestBoard.js");
    const { LlmRequestError } = await import("../src/lib/llmClient.js");
    // 1 worker × 40 s / 10 s = 4 planned clusters; the other 8 are never reached.
    let calls = 0;
    refineClusterWithVisionMock.mockImplementation(async (cluster: Cluster) => {
      if (++calls === 4) throw new LlmRequestError("private provider body", 429, 30);
      return { ...cluster, label: "Vision", summary: "Vision summary.", confirmedNodeIds: [...cluster.nodeIds],
        summarySource: "vision_llm", modelId: "vision-model" };
    });
    const output = await configuredIngest({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "balanced" });
    expect(fetchRenderUrlsMock).toHaveBeenCalledTimes(1);
    expect((fetchRenderUrlsMock.mock.calls[0]![1] as string[])).toHaveLength(4);
    expect(output.qualityReport?.fallbackReasons).toEqual({ rate_limit: 9 });
  });

  it("splits large clusters into 18-node render batches and stops prefetching after a failure", async () => {
    const tree = rawTree();
    tree.document.children[0]!.children = Array.from({ length: 12 }, (_, cluster) => Array.from({ length: 6 }, (_, item) => ({
      id: `drawing:${cluster}:${item}`, name: "Drawing", type: "SHAPE_WITH_TEXT",
      absoluteBoundingBox: { x: cluster * 5000 + item * 110, y: 0, width: 100, height: 100 },
    }))).flat() as typeof tree.document.children[0]["children"];
    fetchFileTreeMock.mockResolvedValue(tree);
    const complete = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "balanced" });
    expect(complete.qualityReport).toMatchObject({ visionClusters: 12, fallbackCount: 0 });
    expect(fetchRenderUrlsMock.mock.calls.map(call => (call[1] as string[]).length)).toEqual([18, 18, 18, 18]);

    fetchRenderUrlsMock.mockClear();
    refineClusterWithVisionMock.mockRejectedValue(new LlmRequestError("private provider body", 429, 30));
    const limited = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "max_quality", forceFullIngest: true });
    // The first batch plus at most the one batch prefetched while it was in use.
    expect(fetchRenderUrlsMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(limited.qualityReport?.fallbackReasons).toEqual({ rate_limit: 12 });
  });

  it("marks every cluster of a rate-limited render batch as rate_limit and keeps the cooldown", async () => {
    fetchFileTreeMock.mockResolvedValueOnce(drawingClusterTree(5));
    fetchRenderUrlsMock.mockRejectedValueOnce(new FigmaApiError("private provider body", 429, 30));
    const before = Date.now();
    const output = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "balanced" });
    expect(fetchRenderUrlsMock).toHaveBeenCalledTimes(1);
    expect(downloadRendersMock).not.toHaveBeenCalled();
    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(output.qualityReport?.fallbackReasons).toEqual({ rate_limit: 5 });
    expect(output.qualityReport?.nextRetryAt).toBeGreaterThanOrEqual(before + 30_000);
  });

  describe("images from image fills", () => {
    const balanced = { figmaFileUrl: "https://www.figma.com/board/AbC123/Test", docStructureHint: "freeform", ingestMode: "balanced" } as const;
    const imageNode = (id: string, ref: string, x: number, size = 100) => ({ id, name: "Image", type: "SHAPE_WITH_TEXT",
      absoluteBoundingBox: { x, y: 0, width: size, height: size }, fills: [{ type: "IMAGE", imageRef: ref }] });
    const treeWith = (children: unknown[]) => {
      const tree = rawTree();
      tree.document.children[0]!.children = children as typeof tree.document.children[0]["children"];
      return tree;
    };

    it("sends the original of an image cluster from one image fills request without rendering", async () => {
      const output = await ingestBoard(balanced);
      expect(fetchImageRefsMock).toHaveBeenCalledTimes(1);
      expect(fetchImageRefsMock).toHaveBeenCalledWith("AbC123", "token", expect.any(AbortSignal));
      expect(fetchRenderUrlsMock).not.toHaveBeenCalled();
      expect(downloadRendersMock).not.toHaveBeenCalled();
      const [cluster, images] = refineClusterWithVisionMock.mock.calls[0] as [Cluster, Buffer[]];
      expect(cluster.nodeIds).toEqual(["1:2"]);
      expect(images).toEqual([jpeg("https://originals.example/image-ref")]);
      const { imageMimeType } = await import("../src/lib/figmaApi.js");
      expect(imageMimeType(images[0]!)).toBe("image/jpeg");
      expect(output.qualityReport?.figmaRequests).toEqual({ imageFills: 1, renders: 0 });
      expect(output.summary).toContain("Figma requests for images: 1 image fills request (Tier 2), 0 render requests (Tier 1).");
      expect((persistBoardMock.mock.calls[0]?.[0] as BoardData).qualityReport?.figmaRequests).toEqual({ imageFills: 1, renders: 0 });
    });

    it("keeps rendering drawings without text while image clusters share one image fills request", async () => {
      fetchFileTreeMock.mockResolvedValueOnce(treeWith([
        ...mixedClusterTree().document.children[0]!.children,
        imageNode("image:2", "image-ref-2", 5000), imageNode("image:3", "image-ref-3", 7000),
      ]));
      const output = await ingestBoard(balanced);
      expect(fetchImageRefsMock).toHaveBeenCalledTimes(1);
      expect(fetchRenderUrlsMock.mock.calls.map(call => call[1])).toEqual([["vector:1", "vector:2"]]);
      expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(4);
      for (const [cluster, images] of refineClusterWithVisionMock.mock.calls as Array<[Cluster, Buffer[]]>) {
        const imageId = cluster.nodeIds.find(id => id.startsWith("image:"));
        if (imageId) expect(images).toHaveLength(1);
        else expect(images).toEqual([render("https://cdn.example/vector:1"), render("https://cdn.example/vector:2")]);
      }
      expect(output.qualityReport).toMatchObject({ visionClusters: 4, figmaRequests: { imageFills: 1, renders: 1 } });
      expect(output.summary).toContain("Figma requests for images: 1 image fills request (Tier 2), 1 render request (Tier 1).");
    });

    it("sends the largest image nodes and nothing rendered beside them", async () => {
      // Seven images and a sticky in one cluster: the six largest images are sent, the sticky stays text.
      fetchFileTreeMock.mockResolvedValueOnce(treeWith([
        ...Array.from({ length: 7 }, (_, index) => imageNode(`image:${index}`, `ref-${index}`, index * 110, 50 + index)),
        { id: "note", name: "Note", type: "STICKY", characters: "A note beside the images.", absoluteBoundingBox: { x: 800, y: 0, width: 300, height: 300 } },
      ]));
      await ingestBoard(balanced);
      expect(fetchRenderUrlsMock).not.toHaveBeenCalled();
      const images = refineClusterWithVisionMock.mock.calls[0]![1] as Buffer[];
      expect(images).toEqual([6, 5, 4, 3, 2, 1].map(index => jpeg(`https://originals.example/ref-${index}`)));
    });

    it("renders only the image nodes whose original is missing, too large or of unknown format", async () => {
      fetchFileTreeMock.mockResolvedValueOnce(treeWith([
        imageNode("good", "good-ref", 0, 140), imageNode("missing", "missing-ref", 110, 130),
        imageNode("large", "large-ref", 220, 120), imageNode("svg", "svg-ref", 330, 110),
      ]));
      fetchImageRefsMock.mockResolvedValueOnce({ "good-ref": "https://originals.example/good", "large-ref": "https://originals.example/large",
        "svg-ref": "https://originals.example/svg" });
      downloadFetchMock.mockImplementation(async (url: string) => url.endsWith("/large")
        ? imageResponse(jpeg(url), 8 * MiB + 1) : url.endsWith("/svg") ? imageResponse(Buffer.from("<svg/>")) : imageResponse(jpeg(url)));
      const output = await ingestBoard(balanced);
      expect(fetchRenderUrlsMock).toHaveBeenCalledTimes(1);
      expect(fetchRenderUrlsMock.mock.calls[0]![1]).toEqual(["missing", "large", "svg"]);
      expect(refineClusterWithVisionMock.mock.calls[0]![1] as Buffer[]).toEqual([
        jpeg("https://originals.example/good"), render("https://cdn.example/missing"), render("https://cdn.example/large"), render("https://cdn.example/svg"),
      ]);
      expect(output.qualityReport).toMatchObject({ visionClusters: 1, figmaRequests: { imageFills: 1, renders: 1 } });
    });

    it("keeps each vision request within 8 MiB of image data", async () => {
      fetchFileTreeMock.mockResolvedValueOnce(treeWith([
        imageNode("first", "first-ref", 0, 140), imageNode("second", "second-ref", 110, 130), imageNode("third", "third-ref", 220, 120),
        imageNode("small", "small-ref", 330, 110),
      ]));
      downloadFetchMock.mockImplementation(async (url: string) => imageResponse(jpeg(url, url.endsWith("small-ref") ? 1024 : 3.5 * MiB)));
      await ingestBoard(balanced);
      const images = refineClusterWithVisionMock.mock.calls[0]![1] as Buffer[];
      // The third 3.5 MiB original would exceed 8 MiB and is left out without a render; the small one still fits.
      expect(images.map(image => image.length)).toEqual([3.5 * MiB, 3.5 * MiB, 1024]);
      expect(images.reduce((sum, image) => sum + image.length, 0)).toBeLessThanOrEqual(8 * MiB);
      expect(fetchRenderUrlsMock).not.toHaveBeenCalled();
    });

    it("scales PNG and JPEG originals above 1,024 px down to JPEG and sends smaller ones byte-identical", async () => {
      fetchFileTreeMock.mockResolvedValueOnce(treeWith([
        imageNode("photo", "jpeg-ref", 0, 140), imageNode("screen", "png-ref", 110, 130), imageNode("small", "small-ref", 220, 120),
      ]));
      const originals: Record<string, Buffer> = {
        "jpeg-ref": syntheticJpeg(2400, 1800), "png-ref": syntheticPng(2400, 1800, true), "small-ref": jpegHeader(900, 600, "small", 200 * 1024),
      };
      downloadFetchMock.mockImplementation(async (url: string) => imageResponse(originals[url.split("/").at(-1)!]!));
      const { imageMimeType } = await import("../src/lib/figmaApi.js");
      await ingestBoard(balanced);
      const images = refineClusterWithVisionMock.mock.calls[0]![1] as Buffer[];
      expect(images).toHaveLength(3);
      for (const image of images.slice(0, 2)) {
        expect(imageMimeType(image)).toBe("image/jpeg");
        expect(imageSize(image, "image/jpeg")).toEqual({ width: 1024, height: 768 });
      }
      expect(images[2]!.equals(originals["small-ref"]!)).toBe(true);
      expect(resizeInWorkerMock.mock.calls.map(call => call[1])).toEqual(["image/jpeg", "image/png"]);
      expect(fetchRenderUrlsMock).not.toHaveBeenCalled();
    });

    it("turns phone photos upright by their EXIF orientation before the 1,024 px bound", async () => {
      fetchFileTreeMock.mockResolvedValueOnce(treeWith([
        imageNode("turned-right", "o6-ref", 0, 140), imageNode("upside-down", "o3-ref", 110, 130), imageNode("turned-left", "o8-ref", 220, 120),
      ]));
      const photo = markedJpeg(2400, 1800);
      const originals: Record<string, Buffer> = { "o6-ref": withOrientation(photo, 6), "o3-ref": withOrientation(photo, 3, true), "o8-ref": withOrientation(photo, 8) };
      downloadFetchMock.mockImplementation(async (url: string) => imageResponse(originals[url.split("/").at(-1)!]!));
      await ingestBoard(balanced);
      // The stored top-left corner is red and the stored top-right corner blue.
      expect((refineClusterWithVisionMock.mock.calls[0]![1] as Buffer[]).map(cornerColours)).toEqual([
        { size: [768, 1024], topLeft: "grey", topRight: "red", bottomLeft: "grey", bottomRight: "blue" },
        { size: [1024, 768], topLeft: "grey", topRight: "grey", bottomLeft: "blue", bottomRight: "red" },
        { size: [768, 1024], topLeft: "blue", topRight: "grey", bottomLeft: "red", bottomRight: "grey" },
      ]);
      expect(fetchRenderUrlsMock).not.toHaveBeenCalled();
    });

    it("encodes a small JPEG again only when its EXIF orientation turns it", async () => {
      fetchFileTreeMock.mockResolvedValueOnce(treeWith([imageNode("turned", "turned-ref", 0, 140), imageNode("plain", "plain-ref", 110, 130)]));
      const originals: Record<string, Buffer> = { "turned-ref": withOrientation(markedJpeg(900, 600), 6), "plain-ref": markedJpeg(900, 600) };
      downloadFetchMock.mockImplementation(async (url: string) => imageResponse(originals[url.split("/").at(-1)!]!));
      await ingestBoard(balanced);
      const [turned, plain] = refineClusterWithVisionMock.mock.calls[0]![1] as Buffer[];
      expect(cornerColours(turned!)).toMatchObject({ size: [600, 900], topRight: "red", bottomRight: "blue" });
      expect(plain!.equals(originals["plain-ref"]!)).toBe(true);
      expect(resizeInWorkerMock).toHaveBeenCalledOnce();
    });

    it("renders instead of decoding 60 megapixels, a broken PNG or a GIF above 1,024 px", async () => {
      fetchFileTreeMock.mockResolvedValueOnce(treeWith([
        imageNode("huge", "huge-ref", 0, 140), imageNode("broken", "broken-ref", 110, 130), imageNode("gif", "gif-ref", 220, 120),
      ]));
      const originals: Record<string, Buffer> = {
        "huge-ref": pngHeader(10_000, 6_000), "broken-ref": Buffer.from("\x89PNG\r\n\x1a\nbroken", "latin1"), "gif-ref": gifHeader(2000, 1500),
      };
      downloadFetchMock.mockImplementation(async (url: string) => imageResponse(originals[url.split("/").at(-1)!]!));
      const output = await ingestBoard(balanced);
      expect(resizeInWorkerMock).not.toHaveBeenCalled();
      expect(fetchRenderUrlsMock.mock.calls.map(call => call[1])).toEqual([["huge", "broken", "gif"]]);
      expect(refineClusterWithVisionMock.mock.calls[0]![1]).toEqual(
        ["huge", "broken", "gif"].map(id => render(`https://cdn.example/${id}`)));
      expect(output.qualityReport).toMatchObject({ visionClusters: 1, figmaRequests: { imageFills: 1, renders: 1 } });
    });

    it("scales renders above 1,024 px down and fails a cluster whose images cannot be bounded like a failed render", async () => {
      fetchFileTreeMock.mockResolvedValueOnce(drawingClusterTree(2));
      downloadRendersMock.mockImplementation(async (ids: string[]) =>
        ids.map(id => id === "drawing:0" ? syntheticPng(1280, 960) : Buffer.from("not an image")));
      const output = await ingestBoard(balanced);
      expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(1);
      const [cluster, images] = refineClusterWithVisionMock.mock.calls[0] as [Cluster, Buffer[]];
      expect(cluster.nodeIds).toEqual(["drawing:0"]);
      expect(imageSize(images[0]!, "image/jpeg")).toEqual({ width: 1024, height: 768 });
      expect(output.qualityReport?.fallbackReasons).toEqual({ render_failed: 1 });
    });

    it.each([
      ["rate limit", () => new FigmaApiError("private provider body", 429, 30), "rate_limit"],
      ["access", () => new FigmaApiError("private provider body", 403), "auth"],
      ["timeout", () => new FigmaTimeoutError("private provider body"), "timeout"],
    ] as const)("handles an image fills %s failure like the same render failure", async (_case, error, reason) => {
      fetchFileTreeMock.mockResolvedValueOnce(drawingClusterTree(3));
      fetchRenderUrlsMock.mockRejectedValueOnce(error());
      const rendered = await ingestBoard(balanced);
      fetchFileTreeMock.mockResolvedValueOnce(imageClusterTree(3));
      fetchImageRefsMock.mockRejectedValueOnce(error());
      const before = Date.now();
      const filled = await ingestBoard(balanced);
      expect(fetchImageRefsMock).toHaveBeenCalledTimes(1);
      expect(downloadFetchMock).not.toHaveBeenCalled();
      expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
      expect(filled.qualityReport?.fallbackReasons).toEqual({ [reason]: 3 });
      expect(filled.qualityReport?.fallbackReasons).toEqual(rendered.qualityReport?.fallbackReasons);
      expect(filled.qualityReport?.figmaRequests).toEqual({ imageFills: 1, renders: 0 });
      expect(JSON.stringify(filled)).not.toContain("private provider body");
      if (reason !== "rate_limit") return;
      expect(filled.qualityReport?.nextRetryAt).toBeGreaterThanOrEqual(before + 30_000);
      // During the cooldown, the next ingest keeps the pending clusters without another Figma request.
      fetchFileTreeMock.mockResolvedValueOnce(imageClusterTree(3));
      readLatestBoardMock.mockResolvedValueOnce(persistBoardMock.mock.calls.at(-1)![0]);
      const cooling = await ingestBoard(balanced);
      expect(fetchImageRefsMock).toHaveBeenCalledTimes(1);
      expect(cooling.qualityReport).toMatchObject({ fallbackReasons: { rate_limit: 3 }, figmaRequests: { imageFills: 0, renders: 0 } });
      expect(cooling.summary).not.toContain("Figma requests");
    });
  });

  describe("focusNodeIds", () => {
    const balanced = { figmaFileUrl: "https://www.figma.com/board/AbC123/Test", docStructureHint: "freeform", ingestMode: "balanced" } as const;
    const box = (x: number, y: number, size = 100) => ({ x, y, width: size, height: size });
    /**
     * Section 5:1 holds three image clusters without text, which the usual priority interprets first.
     * Section 5:2 holds three image clusters with text of growing length, which it interprets last.
     */
    function focusTree() {
      const early = Array.from({ length: 3 }, (_, index) => ({ id: `a:${index}`, name: "Image", type: "SHAPE_WITH_TEXT",
        absoluteBoundingBox: box(index * 5000, 0), fills: [{ type: "IMAGE", imageRef: `ref-a${index}` }] }));
      const late = Array.from({ length: 3 }, (_, index) => [
        { id: `b:${index}`, name: "Image", type: "SHAPE_WITH_TEXT", absoluteBoundingBox: box(index * 5000, 20_000),
          fills: [{ type: "IMAGE", imageRef: `ref-b${index}` }] },
        { id: `t:${index}`, name: "Caption", type: "STICKY", absoluteBoundingBox: box(index * 5000 + 110, 20_000),
          characters: `Caption ${"x".repeat(10 * (index + 1))}` },
      ]).flat();
      return { document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [{ id: "0:1", name: "Page", type: "CANVAS", children: [
        { id: "5:1", name: "Early", type: "SECTION", absoluteBoundingBox: { x: -500, y: -500, width: 16_000, height: 2000 }, children: early },
        { id: "5:2", name: "Late", type: "SECTION", absoluteBoundingBox: { x: -500, y: 19_500, width: 16_000, height: 2000 }, children: late },
      ] }] } };
    }
    const interpretedImages = () => (refineClusterWithVisionMock.mock.calls as Array<[Cluster]>)
      .map(([cluster]) => cluster.nodeIds.find(id => !id.startsWith("t:")));
    /** One worker whose model calls take 15 s each: the 40 s budget interprets two clusters. */
    async function slowIngest() {
      vi.stubEnv("INGEST_BOARD_VISION_CONCURRENCY", "1");
      vi.resetModules();
      vi.useFakeTimers({ toFake: ["Date"] });
      refineClusterWithVisionMock.mockImplementation(async (cluster: Cluster) => {
        vi.setSystemTime(Date.now() + 15_000);
        return { ...cluster, label: "Vision", summary: "Vision summary.", confirmedNodeIds: [...cluster.nodeIds], summarySource: "vision_llm", modelId: "vision-model" };
      });
      return (await import("../src/tools/ingestBoard.js")).ingestBoard;
    }
    const interpretedIn = (board: BoardData) => board.clusters.filter(cluster => cluster.summarySource === "vision_llm")
      .map(cluster => cluster.nodeIds.find(id => !id.startsWith("t:"))).sort();

    it("interprets the image clusters of a focused section first when the budget covers only some", async () => {
      fetchFileTreeMock.mockResolvedValue(focusTree());
      const configuredIngest = await slowIngest();
      const unfocused = await configuredIngest(balanced);
      // The usual priority: two of the text-free image clusters in section 5:1.
      const before = interpretedIn(persistBoardMock.mock.calls[0]![0] as BoardData);
      expect(before).toHaveLength(2);
      expect(before.every(id => id!.startsWith("a:"))).toBe(true);
      expect(unfocused.qualityReport?.focus).toBeUndefined();
      expect(unfocused.summary).not.toContain("Focus:");
      expect(unfocused.summary).toContain("To interpret the images of particular sections first, pass their section IDs as focusNodeIds.");

      const focused = await configuredIngest({ ...balanced, focusNodeIds: ["5:2"] });
      expect(interpretedIn(persistBoardMock.mock.calls[1]![0] as BoardData)).toEqual(["b:0", "b:1"]);
      expect(focused.qualityReport).toMatchObject({ visionClusters: 2, fallbackReasons: { time_budget: 4 },
        focus: { requestedIds: ["5:2"], foundIds: ["5:2"], imageClusters: 3, interpreted: 2, pending: 1 } });
      expect(focused.summary).toContain("Focus: 2 of 3 image clusters interpreted, 1 pending; run ingest_board again with the same focusNodeIds to continue.");
      expect(focused.summary).not.toContain("pass their section IDs as focusNodeIds");
      expect((persistBoardMock.mock.calls[1]![0] as BoardData).qualityReport?.focus).toEqual(focused.qualityReport?.focus);
    });

    it("orders the clusters of several focus IDs by the list and treats a single image node like its cluster", async () => {
      fetchFileTreeMock.mockResolvedValue(focusTree());
      vi.stubEnv("INGEST_BOARD_VISION_CONCURRENCY", "1");
      vi.resetModules();
      const { ingestBoard: configuredIngest } = await import("../src/tools/ingestBoard.js");
      const output = await configuredIngest({ ...balanced, focusNodeIds: ["5:2", "a:2"] });
      const order = interpretedImages();
      expect(order.slice(0, 4)).toEqual(["b:0", "b:1", "b:2", "a:2"]);
      expect(order.slice(4).sort()).toEqual(["a:0", "a:1"]);
      expect(output.qualityReport?.focus).toEqual({ requestedIds: ["5:2", "a:2"], foundIds: ["5:2", "a:2"], imageClusters: 4, interpreted: 4, pending: 0 });
      expect(output.summary).toContain("Focus: 4 of 4 image clusters interpreted, 0 pending.");
      expect(output.summary).not.toContain("run ingest_board again with the same focusNodeIds");
    });

    it("names unknown focus IDs without failing", async () => {
      fetchFileTreeMock.mockResolvedValue(focusTree());
      const output = await ingestBoard({ ...balanced, focusNodeIds: ["9:99", "5:1", "8:88"] });
      expect(output.qualityReport?.focus).toEqual({ requestedIds: ["9:99", "5:1", "8:88"], foundIds: ["5:1"], imageClusters: 3, interpreted: 3, pending: 0 });
      expect(output.summary).toContain("Focus: 3 of 3 image clusters interpreted, 0 pending. 2 of 3 focusNodeIds not found on the board: 9:99, 8:88.");
      expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(6);
    });

    it("has no effect in max_speed", async () => {
      fetchFileTreeMock.mockResolvedValue(focusTree());
      const output = await ingestBoard({ ...balanced, ingestMode: "max_speed", focusNodeIds: ["5:2"] });
      expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
      expect(fetchImageRefsMock).not.toHaveBeenCalled();
      expect(output.qualityReport?.focus).toEqual({ requestedIds: ["5:2"], foundIds: ["5:2"], imageClusters: 0, interpreted: 0, pending: 0 });
      expect(output.summary).toContain("focusNodeIds has no effect in max_speed, which interprets no images.");
      expect(output.summary).not.toContain("Focus:");
    });

    it("reports the focus of a board loaded from cache", async () => {
      readCachedBoardMock.mockResolvedValueOnce(cachedBoard());
      const output = await ingestBoard({ ...balanced, focusNodeIds: ["1:2"] });
      expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
      expect(output.qualityReport?.focus).toEqual({ requestedIds: ["1:2"], foundIds: ["1:2"], imageClusters: 1, interpreted: 1, pending: 0 });
      expect(output.summary).toContain("Focus: 1 of 1 image cluster interpreted, 0 pending.");
    });
  });

  it("tries previously budget-deferred clusters before repeatedly failing clusters", async () => {
    const tree = visionPriorityTree();
    // Without the image, every cluster is rendered and the render request shows the queue order.
    delete (tree.document.children[0]!.children[2] as { fills?: unknown }).fills;
    const nodes = flattenNodeTree(tree);
    const previous: BoardData = { ...cachedBoard(), nodes,
      clusters: partitionedBoardClusters(nodes).map(cluster => ({ ...cluster, label: "Previous",
        summary: "Previous deterministic summary", confirmedNodeIds: cluster.nodeIds,
        summarySource: "deterministic", incomplete: true,
        fallbackReason: cluster.nodeIds.includes("1:3") ? "model_failed" : "time_budget" })) };
    fetchFileTreeMock.mockResolvedValueOnce(tree);
    readLatestBoardMock.mockResolvedValueOnce(previous);
    await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "max_quality" });
    expect(fetchRenderUrlsMock.mock.calls.map(call => call[1])).toEqual([["1:2", "1:1", "1:3"]]);
  });

  it("max_quality mode uses vision for every cluster", async () => {
    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_quality",
    });

    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(2);
    expect(output.qualityReport?.visionClusters).toBe(2);
  });

  it("prioritizes image and low-text vision candidates over canvas order", async () => {
    fetchFileTreeMock.mockResolvedValueOnce(visionPriorityTree());
    vi.stubEnv("INGEST_BOARD_VISION_CONCURRENCY", "1");
    vi.resetModules();
    const { ingestBoard: configuredIngest } = await import("../src/tools/ingestBoard.js");

    await configuredIngest({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_quality",
    });

    expect(refineClusterWithVisionMock.mock.calls.map((call) => (call[0] as Cluster).nodeIds)).toEqual([["1:3"], ["1:2"], ["1:1"]]);
    expect(fetchRenderUrlsMock.mock.calls.map((call) => call[1])).toEqual([["1:2", "1:1"]]);
  });

  it("starts the vision deadline after Figma fetch and re-checks it after screenshots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
    fetchFileTreeMock.mockImplementationOnce(async () => {
      // File download time is outside the dedicated vision-phase budget.
      vi.setSystemTime(Date.now() + 60_000);
      return rawTree();
    });
    fetchImageRefsMock.mockImplementationOnce(async () => {
      // The image fills request itself crosses the 40 s vision deadline.
      vi.setSystemTime(Date.now() + 40_001);
      return { "image-ref": "https://originals.example/image-ref" };
    });

    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "balanced",
    });

    // The image request starts, proving the earlier Figma fetch did not consume
    // the vision budget; the LLM does not start after that budget expires.
    expect(fetchImageRefsMock).toHaveBeenCalledTimes(1);
    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(output.qualityReport).toMatchObject({ fallbackCount: 1, visionClusters: 0, fallbackReasons: { time_budget: 1 } });
  });

  it("returns at the hard vision deadline when a provider never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
    const signals: AbortSignal[] = [];
    let started!: () => void;
    const requestsStarted = new Promise<void>(resolve => { started = resolve; });
    refineClusterWithVisionMock.mockImplementation((...args: unknown[]) => {
      const signal = args[3] as AbortSignal;
      signals.push(signal);
      if (signals.length === 2) started();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const ingest = ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_quality",
    });
    await requestsStarted;
    await vi.advanceTimersByTimeAsync(39_999);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const output = await ingest;

    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(signals.every((signal) => String(signal.reason).includes("40000 ms"))).toBe(true);
    expect(output.qualityReport).toMatchObject({ fallbackCount: 2, visionClusters: 0, fallbackReasons: { timeout: 2 } });
    expect(output.summary).toContain("Visual interpretation is incomplete for 2 clusters: the model did not answer in time (2 clusters).");
  });

  it.each([
    [62_000, 2],
    [70_000, 3],
  ])("with a %i ms budget starts a third 20 s cluster only if 1.25 × the median still fits", async (budget, started) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
    fetchFileTreeMock.mockResolvedValueOnce(imageClusterTree(3));
    vi.stubEnv("INGEST_BOARD_VISION_CONCURRENCY", "1");
    vi.stubEnv("INGEST_BOARD_VISION_BUDGET_MS", String(budget));
    vi.resetModules();
    const { ingestBoard: configuredIngest } = await import("../src/tools/ingestBoard.js");
    refineClusterWithVisionMock.mockImplementation((cluster: Cluster) => new Promise(resolve => setTimeout(() => resolve({
      ...cluster, label: "Vision", summary: "Vision summary.", confirmedNodeIds: [...cluster.nodeIds],
      summarySource: "vision_llm", modelId: "vision-model" }), 20_000)));
    const ingest = configuredIngest({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "balanced" });
    let settled = false;
    ingest.then(() => { settled = true; }, () => { settled = true; });
    for (let elapsed = 0; !settled && elapsed <= budget; elapsed += 1000) await vi.advanceTimersByTimeAsync(1000);
    const output = await ingest;
    // After two 20 s clusters, 22 s remain with a 62 s budget and 30 s with 70 s; 25 s are needed.
    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(started);
    expect(output.qualityReport).toMatchObject({ visionClusters: started,
      fallbackReasons: started === 3 ? {} : { time_budget: 1 } });
  });

  it("aborts hanging screenshot requests at the hard vision deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
    const signals: AbortSignal[] = [];
    let started!: () => void;
    const requestsStarted = new Promise<void>(resolve => { started = resolve; });
    fetchRenderUrlsMock.mockImplementation((...args: unknown[]) => {
      const signal = args[3] as AbortSignal;
      signals.push(signal);
      started();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    fetchFileTreeMock.mockResolvedValueOnce(drawingTree());
    const ingest = ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_quality",
    });
    await requestsStarted;
    await vi.advanceTimersByTimeAsync(40_001);
    const output = await ingest;

    // Both clusters share one render request, which ends at the deadline.
    expect(fetchRenderUrlsMock).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(output.qualityReport).toMatchObject({ fallbackCount: 2, visionClusters: 0, fallbackReasons: { timeout: 2 } });
  });

  it("loads unchanged boards from persistent cache", async () => {
    readCachedBoardMock.mockResolvedValueOnce(cachedBoard());

    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "balanced",
    });

    expect(fetchRenderUrlsMock).not.toHaveBeenCalled();
    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(output.qualityReport?.cachedClusters).toBe(2);
  });

  it.each([undefined, 4])("does not reuse extraction %s even when version and refinement match", async (extractionVersion) => {
    const legacy = { ...cachedBoard(), extractionVersion, figmaVersion: "v1" };
    readCachedBoardMock.mockResolvedValueOnce(legacy);
    readLatestBoardMock.mockResolvedValueOnce(legacy);
    const output = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "max_quality" });
    expect(fetchFileTreeMock).toHaveBeenCalledTimes(1);
    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(2);
    expect(output.qualityReport).toMatchObject({ reusedClusters: 0, cachedClusters: 0 });
    expect(persistBoardMock).toHaveBeenCalledWith(expect.objectContaining({ extractionVersion: 5 }), undefined);
  });

  it("extracts connector arrows as cluster relations", async () => {
    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_speed",
    });

    expect(output.relationCount).toBe(1);

    const persisted = persistBoardMock.mock.calls[0]?.[0] as BoardData;
    expect(persisted.connectorEdges).toEqual([
      { connectorId: "1:3", fromNodeId: "1:1", toNodeId: "1:2", label: "leads to", direction: "forward" },
    ]);
    expect(persisted.clusterRelations).toHaveLength(1);
    expect(persisted.clusterRelations![0]).toMatchObject({
      labels: ["leads to"],
      edgeCount: 1,
    });
    expect(persistBoardMock).toHaveBeenCalledWith(expect.objectContaining({ boardId: "AbC123", cacheKey: "cache-key", snapshotId: "snapshot-id" }), undefined);
  });

  it("keeps cluster order stable when vision calls finish out of order", async () => {
    refineClusterWithVisionMock.mockImplementation(
      async (cluster: Cluster, _screenshots: Buffer[], _nodes: NormalizedNode[]) => {
        // First cluster finishes last — order in the output must not change.
        await new Promise((resolve) =>
          setTimeout(resolve, cluster.nodeIds.includes("1:1") ? 30 : 1),
        );
        return {
          ...cluster,
          label: `Vision ${cluster.id}`,
          summary: "Vision summary.",
          confirmedNodeIds: [...cluster.nodeIds],
          summarySource: "vision_llm" as const,
          modelId: "vision-model",
        };
      },
    );

    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_quality",
    });

    const expected = partitionedBoardClusters(flattenNodeTree(rawTree()));
    expect(output.summary).toContain(expected.map((cluster) => `"Vision ${cluster.id}"`).join(", "));
    expect(output.summary).not.toContain("Largest sections");
    expect((persistBoardMock.mock.calls[0]?.[0] as BoardData).clusters.map((cluster) => cluster.nodeIds)).toEqual([["1:1"], ["1:2"]]);
  });

  it("names the largest sections with IDs in the summary, counted as in get_board_context", async () => {
    // Section k holds k stickies; nine sections, so the summary names the eight largest. One sticky lies outside.
    const sections = Array.from({ length: 9 }, (_, index) => ({
      id: `5:${index + 1}`, name: `Topic ${index + 1}`, type: "SECTION",
      absoluteBoundingBox: { x: index * 3000, y: 0, width: 2000, height: 2000 },
      children: Array.from({ length: index + 1 }, (_, note) => ({
        id: `6:${index * 10 + note}`, name: `Note ${index + 1}.${note + 1}`, type: "STICKY",
        characters: `Note ${index + 1}.${note + 1} about the workshop.`,
        absoluteBoundingBox: { x: index * 3000 + note * 150, y: 0, width: 100, height: 100 },
      })),
    }));
    const outside = { id: "7:1", name: "Parking lot", type: "STICKY", characters: "Parking lot question about the budget.",
      absoluteBoundingBox: { x: 0, y: 5000, width: 100, height: 100 } };
    fetchFileTreeMock.mockResolvedValue({ document: { id: "0:0", name: "Document", type: "DOCUMENT",
      children: [{ id: "0:1", name: "Page", type: "CANVAS", children: [...sections, outside] }] } });

    const output = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/Sections123/Test", docStructureHint: "freeform", ingestMode: "max_speed" });

    const largest = Array.from({ length: 8 }, (_, index) => `5:${9 - index} Topic ${9 - index} — ${9 - index}`).join("; ");
    expect(output.summary).toContain(`Largest sections (ID, name, excerpts): ${largest}. Together they hold 44 of the board's 46 excerpts.`);
    expect(output.summary).toContain("For overviews and summaries, read these sections with get_board_context and nodeIds; answer_from_board is for one specific question." +
      " 1 excerpt lies outside sections; read it with get_board_context and outsideSections: true.");
    expect(output.summary).not.toContain("Topic 1 —");
    expect(output.summary).not.toContain('"Note');
    // The first get_board_context call reads the index the summary built.
    expect(hasEvidenceIndex(redactBoard(getBoard("Sections123")!))).toBe(true);
    const { contextText } = (await getBoardContext({ boardId: "Sections123" })).structuredContent;
    expect(contextText).toContain(`Largest sections (ID, name, excerpts): ${largest}; 5:1 Topic 1 — 1. Together they hold 45 of the board's 46 excerpts.`);
    expect(contextText).toContain("1 excerpt outside sections; read it with outsideSections: true.");
  });

  it("reuses unchanged clusters from the previous ingest", async () => {
    // Previous ingest: "1:1" identical to the current tree (reusable),
    // "1:2" had a different image back then (must be re-refined).
    readLatestBoardMock.mockResolvedValueOnce({
      ...cachedBoard(),
      nodes: [
        {
          id: "1:1",
          name: "Research sticky",
          type: "STICKY",
          x: 0, y: 0, width: 100, height: 100, rotation: 0,
          text: "This text-rich cluster already contains enough extracted research notes.",
        },
        {
          id: "1:2",
          name: "Screenshot",
          type: "SHAPE_WITH_TEXT",
          x: 1000, y: 0, width: 100, height: 100, rotation: 0,
          imageRef: "old-image-ref",
        },
      ],
      clusters: [
        {
          id: "cluster_A",
          label: "Reused research label",
          summary: "Reused research summary.",
          nodeIds: ["1:1"],
          confirmedNodeIds: ["1:1"],
          boundingBox: { x: 0, y: 0, width: 100, height: 100 },
          summarySource: "vision_llm",
          modelId: "old-vision-model",
        },
        {
          id: "cluster_B",
          label: "Stale screenshot label",
          summary: "Stale.",
          nodeIds: ["1:2"],
          confirmedNodeIds: ["1:2"],
          boundingBox: { x: 1000, y: 0, width: 100, height: 100 },
          summarySource: "vision_llm",
        },
      ],
    });

    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_quality",
    });

    // Only the changed cluster hits the vision model.
    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(1);
    expect(output.qualityReport?.reusedClusters).toBe(1);
    expect(output.summary).toContain("Reused research label");
    expect(output.summary).toContain("Reused 1 unchanged cluster");
  });

  it("does not reuse a deterministic summary when vision is due", async () => {
    readLatestBoardMock.mockResolvedValueOnce({
      ...cachedBoard(),
      nodes: [
        {
          id: "1:2",
          name: "Screenshot",
          type: "SHAPE_WITH_TEXT",
          x: 1000, y: 0, width: 100, height: 100, rotation: 0,
          imageRef: "image-ref",
        },
      ],
      clusters: [
        {
          id: "cluster_B",
          label: "Budget fallback label",
          summary: "Deterministic fallback.",
          nodeIds: ["1:2"],
          confirmedNodeIds: ["1:2"],
          boundingBox: { x: 1000, y: 0, width: 100, height: 100 },
          summarySource: "deterministic",
        },
      ],
    });

    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "balanced",
    });

    // Same content hash, but the previous summary was a budget fallback and
    // the image cluster wants vision → upgrade instead of reuse.
    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(1);
    expect(output.qualityReport?.reusedClusters).toBe(0);
  });

  it("forceFullIngest in max_quality downloads the board again and keeps every interpretation", async () => {
    readLatestBoardMock.mockResolvedValueOnce(cachedBoard());
    const output = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "max_quality", forceFullIngest: true });
    expect(fetchFileTreeMock).toHaveBeenCalledTimes(1);
    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(output.qualityReport).toMatchObject({ reusedClusters: 2, visionClusters: 2 });
  });

  it("forceFullIngest bypasses the cache", async () => {
    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_quality",
      forceFullIngest: true,
    });

    expect(readCachedBoardMock).not.toHaveBeenCalled();
    // Without a previous board there is nothing to reuse.
    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(2);
    expect(output.qualityReport?.reusedClusters).toBe(0);
  });

  it("records a history snapshot on fresh ingests", async () => {
    await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_speed",
    });

    expect(persistBoardMock).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: "AbC123", cacheKey: "cache-key", nodeHash: "node-hash", snapshotId: "snapshot-id" }),
      undefined,
    );
  });

  it("maps clusters onto custom phases", async () => {
    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      customPhases: ["Research Notes", "Screenshots"],
      ingestMode: "max_speed",
    });

    expect(output.clusterCount).toBe(2);
    const persisted = persistBoardMock.mock.calls[0]?.[0] as BoardData;
    expect(persisted.clusters.every((cluster) => cluster.phase !== undefined)).toBe(true);
  });
});
