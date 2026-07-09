import { describe, expect, it } from "vitest";
import { mapClustersToPhases } from "../src/lib/docStructureMapper.js";
import type { RefinedCluster } from "../src/types.js";

function cluster(id: string, label: string, summary: string): RefinedCluster {
  return {
    id,
    label,
    summary,
    nodeIds: [id],
    confirmedNodeIds: [id],
    boundingBox: { x: 0, y: 0, width: 100, height: 100 },
  };
}

describe("mapClustersToPhases", () => {
  it("leaves freeform boards untouched", () => {
    const clusters = [cluster("cluster_1", "Notes", "Random notes.")];
    const mapped = mapClustersToPhases(clusters, "freeform");
    expect(mapped[0]?.phase).toBeUndefined();
  });

  it("maps double_diamond clusters as before", () => {
    const mapped = mapClustersToPhases(
      [cluster("cluster_1", "User interviews", "Quotes and research insights from users.")],
      "double_diamond",
    );
    expect(mapped[0]?.phase).toBe("discover");
  });

  it("supports the retro framework, including German keywords", () => {
    const mapped = mapClustersToPhases(
      [
        cluster("cluster_1", "Went well", "Shipping the beta went well, kudos to the team."),
        cluster("cluster_2", "Verbessern", "Deployment war ein Blocker, das müssen wir verbessern."),
        cluster("cluster_3", "Next steps", "Action items with owners for the next sprint."),
      ],
      "retro",
    );

    expect(mapped.map((c) => c.phase)).toEqual([
      "went_well",
      "needs_improvement",
      "action_items",
    ]);
  });

  it("maps onto free-form custom phases by name", () => {
    const mapped = mapClustersToPhases(
      [
        cluster("cluster_1", "Ideen sammeln", "Erste Ideen für das Feature."),
        cluster("cluster_2", "Random", "Nothing that matches a phase name."),
      ],
      "freeform",
      ["Ideen", "Offene Fragen"],
    );

    expect(mapped[0]?.phase).toBe("Ideen");
    expect(mapped[1]?.phase).toBe("unclear");
  });

  it("returns unclear on keyword ties", () => {
    // "idea" (develop) and "interview" (discover) score 1 each — a tie.
    const mapped = mapClustersToPhases(
      [cluster("cluster_1", "Mixed", "One idea and one interview.")],
      "double_diamond",
    );
    expect(mapped[0]?.phase).toBe("unclear");
  });
});
