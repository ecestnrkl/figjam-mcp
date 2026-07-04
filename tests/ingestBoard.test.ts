import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardData, Cluster, NormalizedNode } from "../src/types.js";

const {
  fetchFileTreeMock,
  fetchScreenshotMock,
  refineClusterWithVisionMock,
  readCachedBoardMock,
  writeCachedBoardMock,
} = vi.hoisted(() => ({
  fetchFileTreeMock: vi.fn(),
  fetchScreenshotMock: vi.fn(),
  refineClusterWithVisionMock: vi.fn(),
  readCachedBoardMock: vi.fn(),
  writeCachedBoardMock: vi.fn(),
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
  buildBoardCacheKey: () => "cache-key",
  readCachedBoard: readCachedBoardMock,
  writeCachedBoard: writeCachedBoardMock,
}));

const { ingestBoard } = await import("../src/tools/ingestBoard.js");

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
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.FIGMA_ACCESS_TOKEN;
});

describe("ingestBoard", () => {
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
});
