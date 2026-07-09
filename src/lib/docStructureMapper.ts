import type { DocStructureHint, RefinedCluster } from "../types.js";

/**
 * Maps clusters onto the phases of a documentation framework — deterministic
 * keyword scoring against each cluster's label and summary, no extra LLM
 * call. The label/summary text produced by the vision/text step is
 * descriptive enough for that, and the "unclear" fallback keeps mismatches
 * honest.
 *
 * Built-in frameworks live in FRAMEWORKS; callers can also pass a free-form
 * phase list (customPhases on ingest_board), whose keywords are derived from
 * the phase names themselves.
 */

export interface PhaseDefinition {
  name: string;
  /** Lowercase keyword signals matched against label (2×) and summary (1×). */
  keywords: string[];
}

const FRAMEWORKS: Record<Exclude<DocStructureHint, "freeform">, PhaseDefinition[]> = {
  double_diamond: [
    {
      name: "discover",
      keywords: [
        "research", "interview", "insight", "observation", "survey", "persona",
        "user need", "pain point", "quote", "empathy", "explore", "discovery",
        "finding", "field study", "competitor", "benchmark", "umfrage", "zitat",
      ],
    },
    {
      name: "define",
      keywords: [
        "problem", "define", "how might we", "hmw", "scope", "goal", "requirement",
        "constraint", "framing", "point of view", "synthesis", "target group",
        "hypothesis", "opportunity", "priorit", "ziel", "anforderung", "zielgruppe",
      ],
    },
    {
      name: "develop",
      keywords: [
        "idea", "ideation", "brainstorm", "sketch", "concept", "prototype",
        "solution", "wireframe", "variant", "experiment", "crazy 8", "mockup",
        "design option", "storyboard", "idee", "konzept", "entwurf", "skizze",
      ],
    },
    {
      name: "deliver",
      keywords: [
        "deliver", "launch", "ship", "roadmap", "next step", "action item",
        "timeline", "implementation", "rollout", "release", "mvp", "milestone",
        "test plan", "handoff", "todo", "owner", "umsetzung", "nächste schritte",
      ],
    },
  ],
  lean_canvas: [
    { name: "problem", keywords: ["problem", "pain", "need", "frustration", "existing alternative"] },
    { name: "solution", keywords: ["solution", "feature", "lösung", "approach", "fix"] },
    { name: "value_proposition", keywords: ["value", "unique", "proposition", "promise", "benefit", "nutzen"] },
    { name: "customer_segments", keywords: ["customer", "segment", "target", "audience", "persona", "user group", "zielgruppe"] },
    { name: "channels", keywords: ["channel", "marketing", "reach", "distribution", "social media", "kanal"] },
    { name: "revenue_costs", keywords: ["revenue", "cost", "price", "pricing", "budget", "monetiz", "umsatz", "kosten"] },
    { name: "metrics", keywords: ["metric", "kpi", "measure", "analytics", "retention", "conversion", "messung"] },
    { name: "advantage", keywords: ["advantage", "moat", "unfair", "differentiat", "alleinstellung"] },
  ],
  retro: [
    {
      name: "went_well",
      keywords: ["went well", "good", "success", "win", "proud", "liked", "lief gut", "positiv", "gut gelaufen", "kudos", "danke"],
    },
    {
      name: "needs_improvement",
      keywords: ["improve", "didn't go well", "problem", "issue", "friction", "frustrat", "blocker", "verbessern", "schlecht", "ärger", "hindernis"],
    },
    {
      name: "action_items",
      keywords: ["action", "next step", "todo", "try", "experiment", "owner", "commit", "maßnahme", "nächste schritte", "ausprobieren"],
    },
  ],
  user_journey: [
    { name: "awareness", keywords: ["awareness", "discover", "first contact", "ad", "hears about", "aufmerksam"] },
    { name: "consideration", keywords: ["consider", "compare", "evaluate", "research", "alternative", "vergleich"] },
    { name: "onboarding", keywords: ["onboard", "sign up", "signup", "register", "first use", "setup", "registrier"] },
    { name: "usage", keywords: ["use", "usage", "daily", "task", "workflow", "habit", "interaction", "nutzung", "alltag"] },
    { name: "retention", keywords: ["retention", "return", "churn", "loyal", "recommend", "advocate", "bindung", "empfehl"] },
  ],
};

/**
 * Assigns each cluster a phase from the active framework. Order of
 * precedence: customPhases (free-form names) > built-in framework for the
 * hint > no-op for "freeform". Clusters with no keyword hits — or a tie
 * between phases — get "unclear".
 */
export function mapClustersToPhases(
  clusters: RefinedCluster[],
  hint: DocStructureHint,
  customPhases?: string[],
): RefinedCluster[] {
  const phases =
    customPhases && customPhases.length > 0
      ? customPhases.map(toCustomPhase)
      : hint !== "freeform"
        ? FRAMEWORKS[hint]
        : undefined;

  if (!phases) {
    return clusters;
  }

  return clusters.map((cluster) => ({
    ...cluster,
    phase: classify(cluster, phases),
  }));
}

/**
 * Custom phases arrive as bare names ("Ideen sammeln"), so their keywords
 * are the name itself plus its individual significant words.
 */
function toCustomPhase(name: string): PhaseDefinition {
  const normalized = name.trim().toLowerCase();
  const words = normalized.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2);
  return { name: name.trim(), keywords: [...new Set([normalized, ...words])] };
}

/** Scores one cluster against all phases and picks the unambiguous winner. */
function classify(cluster: RefinedCluster, phases: PhaseDefinition[]): string {
  const label = cluster.label.toLowerCase();
  const summary = cluster.summary.toLowerCase();

  let best = "unclear";
  let bestScore = 0;
  let tied = false;

  for (const phase of phases) {
    const score = phase.keywords.reduce((total, keyword) => {
      const inLabel = label.includes(keyword) ? 2 : 0;
      const inSummary = summary.includes(keyword) ? 1 : 0;
      return total + inLabel + inSummary;
    }, 0);

    if (score > bestScore) {
      best = phase.name;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }

  return bestScore === 0 || tied ? "unclear" : best;
}
