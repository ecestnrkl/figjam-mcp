import type { NormalizedNode, Cluster } from "../types.js";

/**
 * Groups NormalizedNode entries into spatial clusters purely by geometry
 * (proximity / bounding-box overlap on the FigJam canvas), before any
 * vision-based or semantic refinement is applied in visionInterpreter.ts.
 */
export function geometricPreCluster(nodes: NormalizedNode[]): Cluster[] {
  // TODO: implement — siehe Folge-Prompt
  throw new Error("Not implemented");
}
