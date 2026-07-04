import type { DoubleDiamondPhase, RefinedCluster } from "../types.js";

/**
 * Keyword signals per Double Diamond phase, matched against each cluster's
 * label and summary. Deterministic and free (no extra LLM call) — the
 * label/summary text produced by the vision step is descriptive enough for
 * keyword scoring, and the "unclear" fallback keeps mismatches honest.
 */
const PHASE_KEYWORDS: Record<Exclude<DoubleDiamondPhase, "unclear">, string[]> = {
  discover: [
    "research", "interview", "insight", "observation", "survey", "persona",
    "user need", "pain point", "quote", "empathy", "explore", "discovery",
    "finding", "field study", "competitor", "benchmark",
  ],
  define: [
    "problem", "define", "how might we", "hmw", "scope", "goal", "requirement",
    "constraint", "framing", "point of view", "synthesis", "target group",
    "hypothesis", "opportunity", "priorit",
  ],
  develop: [
    "idea", "ideation", "brainstorm", "sketch", "concept", "prototype",
    "solution", "wireframe", "variant", "experiment", "crazy 8", "mockup",
    "design option", "storyboard",
  ],
  deliver: [
    "deliver", "launch", "ship", "roadmap", "next step", "action item",
    "timeline", "implementation", "rollout", "release", "mvp", "milestone",
    "test plan", "handoff", "todo", "owner",
  ],
};

/**
 * Assigns each cluster to one of the four Double Diamond phases (discover /
 * define / develop / deliver) based on keyword hits in its label (double
 * weight) and summary, or "unclear" when no phase wins cleanly (no hits, or
 * a tie between phases). Only called when docStructureHint ===
 * "double_diamond"; freeform boards skip this step.
 */
export function mapToDoubleDiamond(clusters: RefinedCluster[]): RefinedCluster[] {
  return clusters.map((cluster) => ({
    ...cluster,
    phase: classify(cluster),
  }));
}

/** Scores one cluster against all phases and picks the unambiguous winner. */
function classify(cluster: RefinedCluster): DoubleDiamondPhase {
  const label = cluster.label.toLowerCase();
  const summary = cluster.summary.toLowerCase();

  let best: DoubleDiamondPhase = "unclear";
  let bestScore = 0;
  let tied = false;

  for (const [phase, keywords] of Object.entries(PHASE_KEYWORDS)) {
    const score = keywords.reduce((total, keyword) => {
      const inLabel = label.includes(keyword) ? 2 : 0;
      const inSummary = summary.includes(keyword) ? 1 : 0;
      return total + inLabel + inSummary;
    }, 0);

    if (score > bestScore) {
      best = phase as DoubleDiamondPhase;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }

  return bestScore === 0 || tied ? "unclear" : best;
}
