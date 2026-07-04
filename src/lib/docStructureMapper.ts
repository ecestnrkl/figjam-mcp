import type { RefinedCluster } from "../types.js";

/**
 * Maps refined clusters onto the four phases of the Double Diamond design
 * process (discover / define / develop / deliver) based on each cluster's
 * label, summary, and relative position on the board. Only used when
 * docStructureHint === "double_diamond"; freeform boards skip this step.
 */
export function mapToDoubleDiamond(clusters: RefinedCluster[]): RefinedCluster[] {
  // TODO: implement — siehe Folge-Prompt
  throw new Error("Not implemented");
}
