import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cluster, NormalizedNode } from "../src/types.js";

const { chatJsonMock, getVisionModelsMock } = vi.hoisted(() => ({
  chatJsonMock: vi.fn(),
  getVisionModelsMock: vi.fn(),
}));

vi.mock("../src/lib/llmClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/llmClient.js")>()),
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
  it("classifies invalid model fields without exposing the returned content", async () => {
    const { refineClusterWithVision } = await import("../src/lib/visionInterpreter.js");
    chatJsonMock.mockResolvedValue({ label: "", summary: "Private model output", confirmedNodeIds: [] });
    const node = normalizedNode(0);
    const pending = refineClusterWithVision(clusterFor([node]), [], [node]);
    await expect(pending).rejects.toMatchObject({ name: "LlmInvalidJsonError", rawReply: "" });
    await expect(pending).rejects.not.toThrow(/Private model output/);
  });

  it.each([
    ["missing", undefined],
    ["non-array", "node-0"],
    ["non-string member", ["node-0", 42]],
    ["invented member", ["node-0", "private-invented-node"]],
    ["only invented members", ["private-invented-node"]],
  ])("rejects %s confirmed membership instead of hiding invalid output", async (_case, confirmedNodeIds) => {
    const { refineClusterWithVision } = await import("../src/lib/visionInterpreter.js");
    const node = normalizedNode(0);
    chatJsonMock.mockResolvedValue({
      label: "Private model label",
      summary: "Private model summary",
      confirmedNodeIds,
    });

    const pending = refineClusterWithVision(clusterFor([node]), [], [node]);

    await expect(pending).rejects.toMatchObject({ name: "LlmInvalidJsonError", rawReply: "" });
    await expect(pending).rejects.not.toThrow(/Private model|private-invented-node/);
  });

  it("rejects model confirmation of an omitted element even when it exists in the cluster", async () => {
    const { refineClusterWithVision } = await import("../src/lib/visionInterpreter.js");
    const listed = normalizedNode(0);
    const omitted = { ...normalizedNode(1), id: "x".repeat(201) };
    chatJsonMock.mockResolvedValue({
      label: "Unseen element",
      summary: "A model must not claim to have confirmed an omitted element.",
      confirmedNodeIds: [listed.id, omitted.id],
    });

    await expect(refineClusterWithVision(clusterFor([listed, omitted]), [], [listed, omitted]))
      .rejects.toMatchObject({ name: "LlmInvalidJsonError", rawReply: "" });
  });

  it("keeps original cluster data and records the model as the source of valid interpretation", async () => {
    const { refineClusterWithVision } = await import("../src/lib/visionInterpreter.js");
    const nodes = [normalizedNode(0), normalizedNode(1), normalizedNode(2)];
    const cluster = clusterFor(nodes);
    const originalCluster = structuredClone(cluster);
    const originalNodes = structuredClone(nodes);
    chatJsonMock.mockImplementation(async (_models, _messages, options) => {
      options.onModelUsed("actual-vision-model");
      return { label: " Diagram ", summary: " Visible diagram interpretation. ",
        confirmedNodeIds: ["node-2", "node-0", "node-2"] };
    });

    const result = await refineClusterWithVision(cluster, [Buffer.from("synthetic crop")], nodes);

    expect(result).toMatchObject({
      label: "Diagram", summary: "Visible diagram interpretation.",
      confirmedNodeIds: ["node-0", "node-2"],
      summarySource: "vision_llm", modelId: "actual-vision-model",
      nodeIds: originalCluster.nodeIds,
    });
    expect(cluster).toEqual(originalCluster);
    expect(nodes).toEqual(originalNodes);
  });

  it("retains all geometric members when the model deliberately confirms none", async () => {
    const { refineClusterWithVision } = await import("../src/lib/visionInterpreter.js");
    const nodes = [normalizedNode(0), normalizedNode(1)];
    chatJsonMock.mockResolvedValue({ label: "No grouping", summary: "No grouping is clear.", confirmedNodeIds: [] });

    const result = await refineClusterWithVision(clusterFor(nodes), [], nodes);

    expect(result.confirmedNodeIds).toEqual(["node-0", "node-1"]);
  });

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
      role: string; content: Array<{ type: string; text?: string }>;
    }>;
    const prompt = messages.find(message => message.role === "user")?.content.find((part) => part.type === "text")?.text;
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
