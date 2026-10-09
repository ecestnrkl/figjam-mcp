import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardData, Cluster, NormalizedNode } from "../src/types.js";
import { FigmaApiError, FigmaDownloadBudgetError, FigmaTimeoutError } from "../src/lib/figmaApi.js";
import { LLMConfigurationError, LlmInvalidJsonError, LlmRequestError, LlmTimeoutError } from "../src/lib/llmClient.js";

const {
  fetchFileTreeMock,
  fetchFileMetadataMock,
  fetchScreenshotMock,
  refineClusterWithVisionMock,
  readCachedBoardMock,
  persistBoardMock,
  readLatestBoardMock,
  fakeHashClusterNodes,
} = vi.hoisted(() => ({
  fetchFileTreeMock: vi.fn(),
  fetchFileMetadataMock: vi.fn(),
  fetchScreenshotMock: vi.fn(),
  refineClusterWithVisionMock: vi.fn(),
  readCachedBoardMock: vi.fn(),
  persistBoardMock: vi.fn(),
  readLatestBoardMock: vi.fn(),
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
  fetchFileMetadata: fetchFileMetadataMock,
  fetchScreenshot: fetchScreenshotMock,
}));

vi.mock("../src/lib/visionInterpreter.js", () => ({
  refineClusterWithVision: refineClusterWithVisionMock,
}));

vi.mock("../src/lib/persistentCache.js", () => ({
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
  fetchScreenshotMock.mockResolvedValue([Buffer.from("png")]);
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
  fetchFileMetadataMock.mockResolvedValue({ version: "v1" });
  readLatestBoardMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
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

  it("balanced mode uses vision only for image/low-text clusters", async () => {
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

  it("max_speed mode skips vision", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_speed",
    });

    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(fetchScreenshotMock).not.toHaveBeenCalled();
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
    expect(fetchScreenshotMock).not.toHaveBeenCalled();
    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(output.qualityReport).toMatchObject({ fallbackCount: 1, fallbackReasons: { config: 1 } });
    expect(output.summary).toContain("Original extracted texts, tables and node references remain available");
    expect(output.summary).toContain("diagnose_llm_config");
    expect(output.summary).not.toContain("timed out");
  });

  it("does not carry an old vision cooldown into intentional max_speed processing", async () => {
    const previous = cachedBoard();
    previous.clusters = previous.clusters.map(cluster => ({ ...cluster, summarySource: "deterministic",
      incomplete: true, fallbackReason: "rate_limit", retryAfter: Date.now() + 60_000 }));
    readLatestBoardMock.mockResolvedValueOnce(previous);
    const output = await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform", ingestMode: "max_speed" });
    expect(fetchScreenshotMock).not.toHaveBeenCalled();
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
    expect(fetchScreenshotMock).not.toHaveBeenCalled();
    expect(output.qualityReport?.fallbackReasons).toEqual({ vision_failed: 1 });
    expect(output.summary).toContain("older cached failures (cause not recorded)");
  });

  it.each([
    ["render", new Error("private provider body"), "render_failed"],
    ["model", new Error("private provider body"), "model_failed"],
    ["render", new FigmaTimeoutError("private provider body"), "timeout"],
    ["model", new LlmTimeoutError("private provider body"), "timeout"],
    ["model", new LLMConfigurationError("private provider body"), "config"],
    ["model", new LlmRequestError("private provider body", 401), "auth"],
    ["render", new FigmaApiError("private provider body", 403), "auth"],
    ["model", new LlmRequestError("private provider body", 429), "rate_limit"],
    ["model", new LlmInvalidJsonError("private provider body", "private reply text"), "invalid_reply"],
    ["render", new FigmaDownloadBudgetError(), "download_budget"],
  ] as const)("classifies %s failure without exposing provider text (case %#)", async (stage, error, reason) => {
    (stage === "render" ? fetchScreenshotMock : refineClusterWithVisionMock).mockRejectedValueOnce(error);
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
    expect(fetchScreenshotMock).toHaveBeenCalledTimes(3);
    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(3);
    expect(output.qualityReport?.fallbackReasons).toEqual({ rate_limit: 8 });
    expect(output.qualityReport?.nextRetryAt).toBeGreaterThanOrEqual(before + 90_000);
    expect(output.summary).toContain("Retry after");
  });

  it("tries previously budget-deferred clusters before repeatedly failing clusters", async () => {
    const tree = visionPriorityTree();
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
    expect(fetchScreenshotMock.mock.calls.map(call => call[1])).toEqual([["1:2"], ["1:1"], ["1:3"]]);
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

    await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_quality",
    });

    expect(fetchScreenshotMock.mock.calls.map((call) => call[1])).toEqual([
      ["1:3"],
      ["1:2"],
      ["1:1"],
    ]);
  });

  it("starts the vision deadline after Figma fetch and re-checks it after screenshots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
    fetchFileTreeMock.mockImplementationOnce(async () => {
      // File download time is outside the dedicated vision-phase budget.
      vi.setSystemTime(Date.now() + 60_000);
      return rawTree();
    });
    fetchScreenshotMock.mockImplementationOnce(async () => {
      // The screenshot request itself crosses the 35 s vision deadline.
      vi.setSystemTime(Date.now() + 35_001);
      return [Buffer.from("png")];
    });

    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "balanced",
    });

    // The screenshot starts, proving the earlier Figma fetch did not consume
    // the vision budget; the LLM does not start after that budget expires.
    expect(fetchScreenshotMock).toHaveBeenCalledTimes(1);
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
    await vi.advanceTimersByTimeAsync(35_001);
    const output = await ingest;

    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(output.qualityReport).toMatchObject({ fallbackCount: 2, visionClusters: 0, fallbackReasons: { timeout: 2 } });
  });

  it("aborts hanging screenshot requests at the hard vision deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
    const signals: AbortSignal[] = [];
    let started!: () => void;
    const requestsStarted = new Promise<void>(resolve => { started = resolve; });
    fetchScreenshotMock.mockImplementation((...args: unknown[]) => {
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
    await vi.advanceTimersByTimeAsync(35_001);
    const output = await ingest;

    expect(fetchScreenshotMock).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
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

    expect(fetchScreenshotMock).not.toHaveBeenCalled();
    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(output.qualityReport?.cachedClusters).toBe(2);
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
    expect((persistBoardMock.mock.calls[0]?.[0] as BoardData).clusters.map((cluster) => cluster.nodeIds)).toEqual([["1:1"], ["1:2"]]);
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

  it("forceFullIngest bypasses cache and incremental reuse", async () => {
    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_quality",
      forceFullIngest: true,
    });

    expect(readCachedBoardMock).not.toHaveBeenCalled();
    // Latest source may be read to preserve snapshot time, but neither metadata nor refinements are reused.
    expect(fetchFileMetadataMock).not.toHaveBeenCalled();
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
