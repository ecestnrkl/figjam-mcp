import type { Cluster, RefinedCluster } from "../types.js";

/**
 * Sends a cluster's screenshot to a vision-capable model to produce a
 * human-readable label, a short summary, and a description of the visual
 * content (sticky notes, sketches, diagrams, arrows) contained in the
 * cluster's bounding box.
 */
export async function refineClusterWithVision(
  cluster: Cluster,
  screenshotBuf: Buffer,
): Promise<RefinedCluster> {
  // TODO: implement — siehe Folge-Prompt
  throw new Error("Not implemented");
}
