import { boundedText, enclosingIdsLookup, inSectionLookup, retrieveEvidence, type Evidence } from "./evidence.js";
import type { BoardData, NormalizedNode } from "../types.js";

/** The first page names this many of the largest sections before the section tree. */
const LARGEST_SECTIONS_IN_OVERVIEW = 10;

/**
 * The largest sections by excerpts as one line, "" for a board without sections,
 * and the excerpts outside sections, counted as on the first page of get_board_context.
 */
export function sectionGuide(board: BoardData, limit: number): { largestLine: string; outsideSections: number } {
  const index = new SectionIndex(board, retrieveEvidence(board).evidence);
  return { largestLine: index.largestLine(limit), outsideSections: index.outsideSections };
}

interface OutlineLine { depth: number; text: string; section: boolean }

/** Sections, their pages and excerpt counts for first-page orientation. */
export class SectionIndex {
  readonly count: number;
  private readonly sections: NormalizedNode[];
  private readonly pages: NormalizedNode[];
  private readonly enclosing: (nodeId: string) => Set<string>;
  private readonly excerpts = new Map<string, number>();
  private readonly pendingImageClusters = new Map<string, number>();
  private readonly children = new Map<string, NormalizedNode[]>();
  private readonly nodesById: Map<string, NormalizedNode>;
  /** Excerpts that lie in no section. */
  readonly outsideSections: number = 0;

  constructor(private readonly board: BoardData, private readonly evidence: Evidence[]) {
    this.nodesById = new Map(board.nodes.map((node) => [node.id, node]));
    this.enclosing = enclosingIdsLookup(board);
    const order = new Map(board.nodes.map((node, position) => [node.id, position]));
    const readingOrder = (a: NormalizedNode, b: NormalizedNode) => a.y - b.y || a.x - b.x || order.get(a.id)! - order.get(b.id)!;
    this.sections = board.nodes.filter((node) => node.type === "SECTION").sort(readingOrder);
    this.pages = board.nodes.filter((node) => node.type === "CANVAS" || node.type === "PAGE");
    this.count = this.sections.length;
    for (const section of this.sections) {
      // The nearest enclosing section, else the page, is the parent in the tree.
      const parent = section.sectionIds?.filter((id) => id !== section.id).at(-1) ??
        (section.pageId && this.pages.some((page) => page.id === section.pageId) ? section.pageId : "");
      this.children.set(parent, [...(this.children.get(parent) ?? []), section]);
    }
    const inSection = inSectionLookup(board);
    for (const item of evidence) {
      for (const id of this.enclosing(item.renderNodeId ?? item.nodeId)) this.excerpts.set(id, (this.excerpts.get(id) ?? 0) + 1);
      if (!inSection(item)) this.outsideSections++;
    }
    for (const cluster of board.clusters) {
      if (!cluster.incomplete || !cluster.nodeIds[0]) continue;
      for (const id of this.enclosing(cluster.nodeIds[0])) {
        this.pendingImageClusters.set(id, (this.pendingImageClusters.get(id) ?? 0) + 1);
      }
    }
  }

  /** First page of an unfocused request: a bounded page/section guide with IDs. */
  boardOverview(budget: number): string {
    const { board, evidence } = this;
    const size = `${board.clusters.length} cluster${plural(board.clusters.length)}, ${evidence.length} excerpt${plural(evidence.length)}.`;
    const pages = this.pages.filter((page) => this.excerpts.has(page.id) || this.children.has(page.id));
    if (!this.sections.length && pages.length < 2) {
      return fitOutline(["## Board overview", size, "Pass topic or nodeIds for smaller, more precise answers."], [], [], budget, 0);
    }
    const lines: OutlineLine[] = [];
    const addSections = (parentId: string, depth: number) => {
      for (const section of this.children.get(parentId) ?? []) {
        const pending = this.pendingImageClusters.get(section.id) ?? 0;
        lines.push({ depth, section: true, text: `${"  ".repeat(depth)}- ${section.id} ${this.name(section)} — ` +
          `${this.excerptCount(section.id)}${pending ? `, ${pending} image cluster${plural(pending)} not yet interpreted` : ""}` });
        addSections(section.id, depth + 1);
      }
    };
    if (pages.length) {
      for (const page of pages) {
        lines.push({ depth: 0, section: false, text: `- Page ${page.id} ${this.name(page)} — ${this.excerptCount(page.id)}` });
        addSections(page.id, 1);
      }
    } else {
      addSections(pages[0]?.id ?? "", 0);
    }
    const footer = [
      "This compact overview is bounded by the response budget, is not a complete section directory, and may omit empty sections.",
      ...(pages.length
        ? pages.map((page) => `Read this page completely with ${this.readCall([page.id])}; start without a cursor and follow each returned nextCursor with the same arguments.`)
        : [`Read a section with ${this.readCall(["<ID>"])}; start without a cursor and follow each returned nextCursor with the same arguments.`]),
      ...(this.outsideSections ? [`${this.outsideSections} excerpt${plural(this.outsideSections)} lie outside sections; read them separately with outsideSections: true when needed.`] : []),
    ];
    // The largest sections belong to the header, so a small budget shortens the tree first.
    const largest = this.largestLine(LARGEST_SECTIONS_IN_OVERVIEW);
    return fitOutline(["## Board overview", size, ...(largest ? [largest] : []),
      `${pages.length ? "Pages and sections" : "Sections"} in reading order (ID, name, excerpts including nested sections):`],
    lines, footer, budget, pages.length ? 1 : 0);
  }

  /**
   * Sections with the most excerpts, nested sections included, skipping each that
   * lies in one already named; ties go to the outer section, then reading order.
   */
  largestSections(limit: number): Array<{ id: string; name: string; count: number }> {
    const depth = (section: NormalizedNode) => [...this.enclosing(section.id)].filter((id) => this.nodesById.get(id)?.type === "SECTION").length;
    const ranked = this.sections.filter((section) => this.excerpts.has(section.id))
      .sort((a, b) => this.excerpts.get(b.id)! - this.excerpts.get(a.id)! || depth(a) - depth(b));
    const largest: NormalizedNode[] = [];
    for (const section of ranked) {
      if (largest.length === limit) break;
      if (!largest.some((named) => this.enclosing(section.id).has(named.id))) largest.push(section);
    }
    return largest.map((section) => ({ id: section.id, name: this.name(section), count: this.excerpts.get(section.id)! }));
  }

  largestLine(limit: number): string {
    const largest = this.largestSections(limit);
    if (!largest.length) return "";
    const covered = largest.reduce((sum, section) => sum + section.count, 0);
    const heading = largest.length === this.count ? "Sections" : `Largest sections, ${largest.length} of ${this.count}`;
    return `${heading} (ID, name, excerpts): ${largest.map((section) =>
      `${section.id} ${section.name} — ${section.count}`).join("; ")}. ` +
      `${largest.length === 1 ? "It holds" : "Together they hold"} ${covered} of the board's ${this.evidence.length} excerpt${plural(this.evidence.length)}.`;
  }

  /** First page of an outsideSections request; its excerpts are the evidence of this index. */
  outsideOverview(budget: number): string {
    const excerpts = this.evidence.length;
    const clusters = new Set(this.evidence.flatMap((item) => item.clusterId ? [item.clusterId] : [])).size;
    const size = `${excerpts} excerpt${plural(excerpts)} in ${clusters} cluster${plural(clusters)}`;
    const text = ["## Outside sections", this.count
      ? `${size} ${excerpts === 1 ? "lies" : "lie"} outside sections; ${excerpts === 1 ? "it follows" : "they follow"} cluster by cluster in reading order.`
      : `The board has no sections: all ${size}, cluster by cluster in reading order.`].join("\n");
    return JSON.stringify(text).length - 2 <= budget ? text : "";
  }

  /** First page of a nodeIds request: the direct subsections of each requested container. */
  subsectionOutline(containerIds: string[], budget: number): string {
    const lines: OutlineLine[] = [];
    for (const containerId of containerIds) {
      const direct = this.sections.filter((section) => {
        const enclosing = this.enclosing(section.id);
        if (!enclosing.has(containerId)) return false;
        const parent = section.sectionIds?.filter((id) => id !== section.id).at(-1);
        // A section in a frame of another section is still a direct subsection of that frame.
        return !parent || parent === containerId || !this.enclosing(parent).has(containerId);
      });
      if (!direct.length) continue;
      const container = this.nodesById.get(containerId)!;
      lines.push({ depth: 0, section: false, text: `- In ${containerId} ${this.name(container)}:` });
      for (const section of direct) {
        lines.push({ depth: 1, section: true, text: `  - ${section.id} ${this.name(section)} — ${this.excerptCount(section.id)}` });
      }
    }
    if (!lines.length) return "";
    return fitOutline(["## Sections inside (ID, name, excerpts)"], lines,
      containerIds.map((id) => `Read the sections inside this parent with ${this.readCall([id])}; start without a cursor and follow each returned nextCursor with the same arguments.`),
      budget, 1);
  }

  private readCall(nodeIds: string[]): string {
    return `get_board_context ${JSON.stringify({
      boardId: this.board.fileKey,
      snapshotId: this.board.snapshotId,
      nodeIds,
      detail: "auto",
      maxChars: 24000,
    })}`;
  }

  /** First page of a request whose IDs share every page: each requested ID with its excerpts on all pages. */
  requestedOutline(counts: Array<{ id: string; count: number }>, budget: number): string {
    const lines = counts.map(({ id, count }) => {
      const node = this.nodesById.get(id);
      return `- ${id}${node ? ` ${this.name(node)}` : ""} — ${count} excerpt${plural(count)}`;
    });
    const render = (shown: number) => {
      const omitted = lines.length - shown;
      return ["## Requested IDs, which share every page (ID, name, excerpts on all pages)", ...lines.slice(0, shown),
        ...(omitted > 0 ? [`${omitted} more requested ID${plural(omitted)} not listed.`] : [])].join("\n");
    };
    const fits = (text: string) => JSON.stringify(text).length - 2 <= budget;
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (fits(render(middle))) low = middle;
      else high = middle - 1;
    }
    return fits(render(low)) ? render(low) : "";
  }

  private excerptCount(id: string): string {
    const count = this.excerpts.get(id) ?? 0;
    return `${count} excerpt${plural(count)}`;
  }

  private name(node: NormalizedNode): string {
    const name = node.name.replace(/\s+/g, " ").trim();
    if (name) return boundedText(name, 80);
    return node.type === "SECTION" ? "(unnamed section)" : `(unnamed ${node.type === "CANVAS" || node.type === "PAGE" ? "page" : node.type.toLowerCase()})`;
  }
}

/**
 * Lines that do not fit the budget are summarized in one line: deeper levels
 * go first, then the last lines down to minDepth. Returns "" if nothing fits.
 */
function fitOutline(header: string[], lines: OutlineLine[], footer: string[], budget: number, minDepth: number): string {
  const sectionCount = lines.filter((line) => line.section).length;
  const render = (shown: OutlineLine[]) => {
    const omitted = sectionCount - shown.filter((line) => line.section).length;
    const summary = omitted > 0
      ? [`${omitted} more section${plural(omitted)} not listed; use the page or parent IDs above to continue. Empty sections may be absent.`] : [];
    return [...header, ...shown.map((line) => line.text), ...summary, ...footer].join("\n");
  };
  const fits = (text: string) => JSON.stringify(text).length - 2 <= budget;
  const deepest = Math.max(minDepth, ...lines.map((line) => line.depth));
  for (let depth = deepest; depth >= minDepth; depth--) {
    const text = render(lines.filter((line) => line.depth <= depth));
    if (fits(text)) return text;
  }
  const shallow = lines.filter((line) => line.depth <= minDepth);
  let low = 0;
  let high = shallow.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (fits(render(shallow.slice(0, middle)))) low = middle;
    else high = middle - 1;
  }
  const text = render(shallow.slice(0, low));
  return fits(text) ? text : "";
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}
