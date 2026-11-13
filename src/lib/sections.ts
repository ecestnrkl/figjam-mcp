import { boundedText, enclosingIdsLookup, inSectionLookup, retrieveEvidence, snapshotIdForBoard, type Evidence } from "./evidence.js";
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

interface OutlineLine { depth: number; text: string; section: boolean; parentId?: string }

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
  boardOverview(budget: number, includeSinglePage = true): string {
    const { board, evidence } = this;
    const size = `${board.clusters.length} cluster${plural(board.clusters.length)}, ${evidence.length} excerpt${plural(evidence.length)}.`;
    const pages = this.pages.filter((page) => this.excerpts.has(page.id) || this.children.has(page.id));
    if (!this.sections.length && (!pages.length || (!includeSinglePage && pages.length === 1))) {
      return fitOutline(["## Board overview", size, "Pass topic or nodeIds for smaller, more precise answers."], [], [[]], budget, {});
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
    const read = `Read a ${pages.length ? "page" : "section"} with ${this.readCall([pages[0]?.id ?? "<ID>"])}; repeat unchanged with nextCursor.`;
    const footer = [
      "Bounded overview; not a complete section directory. Empty sections may be omitted.",
      ...(pages.length > 1 ? ["Use the same call for each listed page ID."] : []),
      read,
      ...(this.outsideSections && this.sections.length ? [`${this.outsideSections} excerpt${plural(this.outsideSections)} outside sections; page reads include them.`] : []),
    ];
    // A small budget sheds optional footer guidance before the reusable read call.
    const largest = this.largestLine(LARGEST_SECTIONS_IN_OVERVIEW);
    const header = ["## Board overview", size, ...(largest ? [largest] : []),
      `${pages.length ? "Pages and sections" : "Sections"} in reading order (ID, name, excerpts including nested sections):`];
    const footers = [footer, footer.slice(1), footer.filter((line) => line === read || line.includes("outside sections")), [read], []];
    return fitOutline(header, lines, footers, budget, { pages: true });
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
        lines.push({ depth: 1, section: true, parentId: containerId, text: `  - ${section.id} ${this.name(section)} — ${this.excerptCount(section.id)}` });
      }
    }
    if (!lines.length) return "";
    return fitOutline(["## Sections inside (ID, name, excerpts)"], lines,
      [["Read one with nodeIds: [\"<ID>\"]."]], budget, {
        omittedFooter: (shown, short) => {
          const kept = new Set(shown);
          const incomplete = [...new Set(lines.filter((line) => line.section && !kept.has(line)).map((line) => line.parentId!))];
          if (!incomplete.length) return [];
          // Keep the parent list bounded even for requests with fifty containers.
          const ids = incomplete.slice(0, 4).join(", ");
          const more = incomplete.length - Math.min(4, incomplete.length);
          const parents = `${ids}${more ? ` and ${more} more` : ""}`;
          return [short
            ? `Incomplete child lists for requested parents ${parents}; read one parent with detail "auto".`
            : `Incomplete child lists for requested parents ${parents}: ${this.readCall([incomplete[0]!])}; repeat unchanged with nextCursor.`];
        },
      });
  }

  private readCall(nodeIds: string[]): string {
    return `get_board_context ${JSON.stringify({
      boardId: this.board.fileKey,
      snapshotId: snapshotIdForBoard(this.board),
      nodeIds,
      detail: "auto",
      maxChars: 24000,
    })}`;
  }

  /** First page of a request whose IDs share every page: each requested ID with its excerpts on all pages. */
  requestedOutline(counts: Array<{ id: string; count: number }>, budget: number): string {
    const lines = counts.map(({ id, count }) => {
      const node = this.nodesById.get(id);
      return `- ${id}${node ? ` ${this.name(node)}` : ""} — ${node?.hiddenDescendantIds ? hiddenSectionNotice(node.hiddenDescendantIds.length) : `${count} excerpt${plural(count)}`}`;
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
    const hidden = this.nodesById.get(id)?.hiddenDescendantIds;
    if (hidden) return hiddenSectionNotice(hidden.length);
    const count = this.excerpts.get(id) ?? 0;
    return `${count} excerpt${plural(count)}`;
  }

  private name(node: NormalizedNode): string {
    const name = node.name.replace(/\s+/g, " ").trim();
    if (name) return boundedText(name, 80);
    return node.type === "SECTION" ? "(unnamed section)" : `(unnamed ${node.type === "CANVAS" || node.type === "PAGE" ? "page" : node.type.toLowerCase()})`;
  }
}

/** Keep page/parent lines first, then shallow sections, then deeper sections. */
function fitOutline(
  header: string[], lines: OutlineLine[], footers: string[][], budget: number,
  options: { pages?: boolean; omittedFooter?: (shown: OutlineLine[], short: boolean) => string[] },
): string {
  const sectionCount = lines.filter((line) => line.section).length;
  const pageCount = options.pages ? lines.filter((line) => !line.section).length : 0;
  const render = (shown: OutlineLine[], footer: string[], omittedStyle: "full" | "short" | "none") => {
    const omitted = sectionCount - shown.filter((line) => line.section).length;
    const omittedPages = pageCount - shown.filter((line) => !line.section).length;
    const summary = [
      ...(omitted > 0 ? [`${omitted} more section${plural(omitted)} not listed; use the page or parent IDs above to continue. Empty sections may be absent.`] : []),
      ...(omittedPages > 0 ? [`${omittedPages} more page${plural(omittedPages)} not listed in this bounded overview.`] : []),
    ];
    return [...header, ...shown.map((line) => line.text), ...summary, ...footer,
      ...(omittedStyle === "none" ? [] : options.omittedFooter?.(shown, omittedStyle === "short") ?? [])].join("\n");
  };
  const fits = (text: string) => JSON.stringify(text).length - 2 <= budget;
  const priority = lines.map((line, index) => ({ line, index })).sort((a, b) =>
    Number(a.line.section) - Number(b.line.section) || a.line.depth - b.line.depth || a.index - b.index);
  const shown = (count: number) => priority.slice(0, count).sort((a, b) => a.index - b.index).map(({ line }) => line);
  // Reserve at least the first page or parent line where one exists. Footer
  // variants drop the directory caveat, multi-page addition, then the read call.
  const styles: Array<"full" | "short" | "none"> = options.omittedFooter ? ["full", "short", "none"] : ["none"];
  for (const style of styles) {
    let footer = footers.at(-1) ?? [];
    for (const candidate of footers) {
      if (fits(render(lines, candidate, style)) || fits(render(shown(Math.min(1, lines.length)), candidate, style))) { footer = candidate; break; }
    }
    const complete = render(lines, footer, style);
    if (fits(complete)) return complete;
    // Prefer a shorter omission hint over an outline with no parent at all.
    if (lines.length && !fits(render(shown(1), footer, style)) && style !== "none") continue;
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (fits(render(shown(middle), footer, style))) low = middle;
      else high = middle - 1;
    }
    const text = render(shown(low), footer, style);
    if (fits(text)) return text;
  }
  return "";
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

export function hiddenSectionNotice(count: number): string {
  return `Contents hidden in FigJam; ${count} element${plural(count)} not read`;
}
