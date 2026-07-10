import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardData, Cluster, NormalizedNode } from "../src/types.js";

const {
  fetchFileTreeMock,
  fetchScreenshotMock,
  refineClusterWithVisionMock,
  readCachedBoardMock,
  writeCachedBoardMock,
  writeLatestBoardPointerMock,
  readLatestBoardMock,
  writeBoardHistoryEntryMock,
  fakeHashClusterNodes,
} = vi.hoisted(() => ({
  fetchFileTreeMock: vi.fn(),
  fetchScreenshotMock: vi.fn(),
  refineClusterWithVisionMock: vi.fn(),
  readCachedBoardMock: vi.fn(),
  writeCachedBoardMock: vi.fn(),
  writeLatestBoardPointerMock: vi.fn(),
  readLatestBoardMock: vi.fn(),
  writeBoardHistoryEntryMock: vi.fn(),
  // Deterministic stand-in with the same semantics as the real hash:
  // id + text + imageRef, order-independent.
  fakeHashClusterNodes: (nodes: Array<{ id: string; text?: string; imageRef?: string }>) =>
    JSON.stringify(
      nodes.map((n) => [n.id, n.text?.trim() ?? "", n.imageRef ?? ""]).sort(),
    ),
}));

vi.mock("../src/lib/figmaApi.js", () => ({
  fetchFileTree: fetchFileTreeMock,
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
  writeCachedBoard: writeCachedBoardMock,
  writeLatestBoardPointer: writeLatestBoardPointerMock,
  readLatestBoard: readLatestBoardMock,
  writeBoardHistoryEntry: writeBoardHistoryEntryMock,
}));

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

function cachedBoard(): BoardData {
  return {
    boardId: "AbC123",
    fileKey: "AbC123",
    docStructureHint: "freeform",
    ingestMode: "balanced",
    nodes: [],
    clusters: [
      {
        id: "cluster_1",
        label: "Cached",
        summary: "Cached summary.",
        confirmedNodeIds: ["1:1"],
        nodeIds: ["1:1"],
        boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      },
    ],
    createdAt: 1,
  };
}

beforeEach(() => {
  process.env.FIGMA_ACCESS_TOKEN = "token";
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
  writeCachedBoardMock.mockResolvedValue(undefined);
  writeLatestBoardPointerMock.mockResolvedValue(undefined);
  readLatestBoardMock.mockResolvedValue(undefined);
  writeBoardHistoryEntryMock.mockResolvedValue(undefined);
});

afterEach(() => {
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

    expect(fetchFileTreeMock).toHaveBeenCalledWith("AbC123", "explicit-token");
  });

  it("trims the Figma token read from the environment", async () => {
    process.env.FIGMA_ACCESS_TOKEN = "  environment-token  ";

    await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_speed",
    });

    expect(fetchFileTreeMock).toHaveBeenCalledWith("AbC123", "environment-token");
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
    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_speed",
    });

    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(fetchScreenshotMock).not.toHaveBeenCalled();
    expect(output.qualityReport?.deterministicClusters).toBe(2);
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

  it("loads unchanged boards from persistent cache", async () => {
    readCachedBoardMock.mockResolvedValueOnce(cachedBoard());

    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "balanced",
    });

    expect(fetchScreenshotMock).not.toHaveBeenCalled();
    expect(refineClusterWithVisionMock).not.toHaveBeenCalled();
    expect(output.qualityReport?.cachedClusters).toBe(1);
  });

  it("extracts connector arrows as cluster relations", async () => {
    const output = await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_speed",
    });

    expect(output.relationCount).toBe(1);

    const persisted = writeCachedBoardMock.mock.calls[0]?.[1] as BoardData;
    expect(persisted.connectorEdges).toEqual([
      { connectorId: "1:3", fromNodeId: "1:1", toNodeId: "1:2", label: "leads to" },
    ]);
    expect(persisted.clusterRelations).toHaveLength(1);
    expect(persisted.clusterRelations![0]).toMatchObject({
      labels: ["leads to"],
      edgeCount: 1,
    });
    expect(writeLatestBoardPointerMock).toHaveBeenCalledWith("AbC123", "cache-key");
  });

  it("keeps cluster order stable when vision calls finish out of order", async () => {
    refineClusterWithVisionMock.mockImplementation(
      async (cluster: Cluster, _screenshots: Buffer[], _nodes: NormalizedNode[]) => {
        // First cluster finishes last — order in the output must not change.
        await new Promise((resolve) =>
          setTimeout(resolve, cluster.id === "cluster_1" ? 30 : 1),
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

    expect(output.summary).toContain('"Vision cluster_1", "Vision cluster_2"');
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
    expect(readLatestBoardMock).not.toHaveBeenCalled();
    expect(refineClusterWithVisionMock).toHaveBeenCalledTimes(2);
    expect(output.qualityReport?.reusedClusters).toBe(0);
  });

  it("records a history snapshot on fresh ingests", async () => {
    await ingestBoard({
      figmaFileUrl: "https://www.figma.com/board/AbC123/Test",
      docStructureHint: "freeform",
      ingestMode: "max_speed",
    });

    expect(writeBoardHistoryEntryMock).toHaveBeenCalledWith(
      "AbC123",
      expect.objectContaining({ cacheKey: "cache-key", nodeHash: "node-hash" }),
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
    const persisted = writeCachedBoardMock.mock.calls[0]?.[1] as BoardData;
    expect(persisted.clusters.every((cluster) => cluster.phase !== undefined)).toBe(true);
  });
});
