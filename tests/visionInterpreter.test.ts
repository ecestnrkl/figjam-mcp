import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cluster, NormalizedNode } from "../src/types.js";

const { chatJsonMock, getVisionModelsMock } = vi.hoisted(() => ({
  chatJsonMock: vi.fn(),
  getVisionModelsMock: vi.fn(),
}));

vi.mock("../src/lib/llmClient.js", () => ({
  chatJson: chatJsonMock,
  getVisionModels: getVisionModelsMock,
}));

beforeEach(() => {
  chatJsonMock.mockReset();
  getVisionModelsMock.mockReset();
  getVisionModelsMock.mockReturnValue(["vision-model"]);
  chatJsonMock.mockResolvedValue({
    label: "Bounded inventory",
    summary: "The cluster was analyzed from a bounded inventory.",
    confirmedNodeIds: ["node-0"],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("refineClusterWithVision", () => {
  it("uses an independently configurable, moderate vision reply budget", async () => {
    vi.stubEnv("LLM_VISION_MAX_OUTPUT_TOKENS", "2304");
    const { refineClusterWithVision } = await import("../src/lib/visionInterpreter.js");
    const node = normalizedNode(0);

    await refineClusterWithVision(clusterFor([node]), [], [node]);

    expect(chatJsonMock).toHaveBeenCalledWith(
      ["vision-model"],
      expect.any(Array),
      expect.objectContaining({ maxOutputTokens: 2304 }),
    );
  });

  it("forwards caller cancellation to the shared LLM client", async () => {
    const { refineClusterWithVision } = await import("../src/lib/visionInterpreter.js");
    const node = normalizedNode(0);
    const controller = new AbortController();

    await refineClusterWithVision(clusterFor([node]), [], [node], controller.signal);

    expect(chatJsonMock.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
  });

  it("bounds huge inventories by node count and characters and retains omitted nodes", async () => {
    const { refineClusterWithVision } = await import("../src/lib/visionInterpreter.js");
    const nodes = Array.from({ length: 500 }, (_, index) => normalizedNode(index));

    const result = await refineClusterWithVision(clusterFor(nodes), [], nodes);

    const messages = chatJsonMock.mock.calls[0]?.[1] as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    const prompt = messages[0]?.content.find((part) => part.type === "text")?.text;
    expect(prompt).toBeDefined();

    const inventory = prompt!
      .split("Elements (id (type): text):\n")[1]!
      .split("\n\nTasks:")[0]!;
    const shownIds = [...inventory.matchAll(/^- ([^ ]+) \(/gm)].map((match) => match[1]!);
    const hiddenId = nodes.map((node) => node.id).find((id) => !shownIds.includes(id));
    const rejectedShownId = shownIds.find((id) => id !== "node-0");

    expect(inventory.length).toBeLessThanOrEqual(24_000);
    expect(shownIds.length).toBeLessThanOrEqual(160);
    expect(inventory).toMatch(/Inventory truncated: showing \d+ of 500 elements/);
    expect(hiddenId).toBeDefined();
    expect(rejectedShownId).toBeDefined();

    // The model may reject listed outliers, but it cannot silently discard
    // nodes that were hidden only because the prompt reached its safety cap.
    expect(result.confirmedNodeIds).toContain("node-0");
    expect(result.confirmedNodeIds).toContain(hiddenId);
    expect(result.confirmedNodeIds).not.toContain(rejectedShownId);
  });
});

function normalizedNode(index: number): NormalizedNode {
  return {
    id: `node-${index}`,
    name: `Node ${index}`,
    type: "STICKY",
    x: index * 10,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    text: `Research item ${index}: ${"x".repeat(900)}`,
    ...(index % 10 === 0 ? { imageRef: `image-${index}` } : {}),
  };
}

function clusterFor(nodes: NormalizedNode[]): Cluster {
  return {
    id: "cluster_large",
    nodeIds: nodes.map((node) => node.id),
    boundingBox: { x: 0, y: 0, width: nodes.length * 10 + 100, height: 100 },
  };
}
