import type OpenAI from "openai";
import type { Cluster, NormalizedNode, RefinedCluster } from "../types.js";
import { chatJson, getVisionModel } from "./llmClient.js";

/**
 * Refines one geometric cluster with a vision-capable model.
 *
 * Sends all screenshot crops for the cluster (one image per rendered node,
 * as separate image_url blocks in a single request) together with the
 * already-extracted text content. The model:
 *  (a) confirms or corrects which nodes actually belong together
 *      thematically → `confirmedNodeIds`,
 *  (b) assigns a short, meaningful label,
 *  (c) describes any image/screenshot content and folds it into the summary,
 *  (d) produces a compact 3–5 sentence summary of the whole cluster.
 */
export async function refineClusterWithVision(
  cluster: Cluster,
  screenshots: Buffer[],
  clusterNodes: NormalizedNode[],
): Promise<RefinedCluster> {
  const prompt = buildPrompt(cluster, clusterNodes);

  const content: OpenAI.ChatCompletionContentPart[] = [
    { type: "text", text: prompt },
    ...screenshots.map(
      (buf): OpenAI.ChatCompletionContentPart => ({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${buf.toString("base64")}` },
      }),
    ),
  ];

  const reply = await chatJson(getVisionModel(), [{ role: "user", content }]);
  return applyReply(cluster, reply);
}

/** Builds the instruction text: task description + per-node text inventory. */
function buildPrompt(cluster: Cluster, clusterNodes: NormalizedNode[]): string {
  const inventory = clusterNodes
    .map((node) => {
      const text = node.text?.trim();
      const image = node.imageRef ? " [contains image]" : "";
      return `- ${node.id} (${node.type})${image}${text ? `: "${truncate(text, 300)}"` : ""}`;
    })
    .join("\n");

  return [
    "You are analyzing one spatially grouped area of a FigJam whiteboard (brainstorming/research board).",
    "The attached images are screenshots of individual elements from this group; the list below is the extracted text per element.",
    "",
    "Elements (id (type): text):",
    inventory,
    "",
    "Tasks:",
    "1. Decide which elements truly belong together thematically. Drop outliers that only happen to sit nearby (return the ids you keep as confirmedNodeIds — usually all of them).",
    "2. Give the group a short, meaningful label (max 6 words).",
    "3. Write a compact summary of the group in 3-5 sentences. If elements contain images/screenshots, describe their content in 1-2 of those sentences.",
    "",
    'Reply with JSON only, exactly this shape: {"label": string, "summary": string, "confirmedNodeIds": string[]}',
  ].join("\n");
}

/** Validates the model's JSON reply and merges it into a RefinedCluster. */
function applyReply(cluster: Cluster, reply: unknown): RefinedCluster {
  const parsed = reply as {
    label?: unknown;
    summary?: unknown;
    confirmedNodeIds?: unknown;
  } | null;

  const label = typeof parsed?.label === "string" ? parsed.label.trim() : "";
  const summary = typeof parsed?.summary === "string" ? parsed.summary.trim() : "";
  if (!label || !summary) {
    throw new Error(
      `Vision model reply for ${cluster.id} is missing "label" or "summary"`,
    );
  }

  // Keep only ids that really exist in the cluster (models sometimes invent
  // ids); an empty/invalid list falls back to the full geometric cluster.
  const valid = new Set(cluster.nodeIds);
  const confirmed = Array.isArray(parsed?.confirmedNodeIds)
    ? parsed.confirmedNodeIds.filter(
        (id): id is string => typeof id === "string" && valid.has(id),
      )
    : [];

  return {
    ...cluster,
    label,
    summary,
    confirmedNodeIds: confirmed.length > 0 ? confirmed : [...cluster.nodeIds],
  };
}

/** Truncates long sticky texts so a single node can't blow up the prompt. */
function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
