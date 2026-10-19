import type { BoardData, NormalizedNode, RefinedCluster } from "../../src/types.js";

export interface LargeBoardOptions {
  /** Nested sections per section; clusters rotate between a section and its subsections. */
  subsections?: number;
  /** Extra clusters of one short text label each. */
  shortLabels?: number;
  /** Extra clusters of one image each, not yet interpreted. */
  imageClusters?: number;
}

/**
 * Synthetic workshop board: stickies are named after their text as FigJam does,
 * frames and vectors mostly keep default names, and clusters carry deterministic
 * summaries in the ingest_board format.
 */
export function largeBoard(
  boardId: string, clusterCount = 300, stickiesPerCluster = 10, sectionCount = 12, options: LargeBoardOptions = {},
): BoardData {
  const page: NormalizedNode = { id: "0:1", name: "Workshop", type: "CANVAS", x: 0, y: 0, width: 0, height: 0, rotation: 0 };
  const sections: NormalizedNode[] = Array.from({ length: sectionCount }, (_, index) => ({
    id: `1:${index}`, name: `Theme ${index + 1}`, type: "SECTION", x: 0, y: 0, width: 0, height: 0, rotation: 0, pageId: page.id,
  }));
  const subsections = sections.flatMap((section, index) => Array.from({ length: options.subsections ?? 0 }, (_, sub): NormalizedNode => ({
    id: `2:${index * 100 + sub}`, name: `Theme ${index + 1}.${sub + 1}`, type: "SECTION", x: 0, y: (sub + 1) * 5000,
    width: 0, height: 0, rotation: 0, pageId: page.id, parentId: section.id, sectionIds: [section.id, `2:${index * 100 + sub}`],
  })));
  const nodes: NormalizedNode[] = [page, ...sections, ...subsections];
  const clusters: RefinedCluster[] = [];
  const sectionPath = (index: number, rotation: number): string[] => {
    const section = sections[index]!;
    const sub = rotation % ((options.subsections ?? 0) + 1);
    return sub === 0 ? [section.id] : [section.id, `2:${index * 100 + sub - 1}`];
  };
  for (let c = 0; c < clusterCount; c++) {
    // Uneven section sizes give the board overview a meaningful order.
    const sectionIds = sectionPath(Math.floor(Math.sqrt(c / clusterCount) * sectionCount), c);
    const stickies = Array.from({ length: stickiesPerCluster }, (_, s): NormalizedNode => {
      const text = `Participant ${c}-${s} said onboarding step ${s} feels slow on mobile.`;
      return {
        id: `${c + 10}:${s}`, name: text, type: "STICKY", text, x: c * 400, y: s * 120, width: 100, height: 100,
        rotation: 0, pageId: page.id, sectionIds,
      };
    });
    // Tree order puts containers and drawings before the stickies on them.
    const shape = (id: string, name: string, type: string): NormalizedNode => ({
      id, name, type, x: c * 400, y: 0, width: 300, height: 1200, rotation: 0, pageId: page.id, sectionIds,
    });
    const decorations = [shape(`${c + 10}:100`, `Frame ${c + 1}`, "FRAME"), shape(`${c + 10}:101`, "Vector", "VECTOR")];
    if (c % 10 === 0) decorations.push(shape(`${c + 10}:102`, `Journey map ${c}`, "FRAME"));
    nodes.push(...decorations, ...stickies);
    const highlights = stickies.slice(0, 5).map((node) => `"${node.text}"`).join("; ");
    clusters.push({
      id: `cluster_${c}`, label: `Participant ${c}-0 said onboarding step`,
      nodeIds: [...decorations, ...stickies].map((node) => node.id),
      confirmedNodeIds: stickies.map((node) => node.id), boundingBox: { x: c * 400, y: 0, width: 100, height: 1200 },
      summarySource: "deterministic",
      summary: `Cluster contains ${stickies.length} board elements with ${stickies.length} extracted text items. ` +
        `Extracted text highlights: ${highlights}. The source node IDs are retained for follow-up context.`,
    });
  }
  const single = (id: string, node: Omit<NormalizedNode, "id" | "x" | "y" | "width" | "height" | "rotation" | "pageId" | "sectionIds">,
    position: number, extra: Partial<RefinedCluster>) => {
    const sectionIds = sectionPath(position % sectionCount, position);
    const x = position * 400;
    nodes.push({ ...node, id, x, y: 3000, width: 100, height: 40, rotation: 0, pageId: page.id, sectionIds });
    clusters.push({ id: `cluster_${id}`, label: node.name, nodeIds: [id], confirmedNodeIds: [id],
      boundingBox: { x, y: 3000, width: 100, height: 40 }, summarySource: "deterministic", summary: "", ...extra });
  };
  for (let k = 0; k < (options.shortLabels ?? 0); k++) {
    single(`3:${k}`, { name: `Step ${k + 1}`, type: "TEXT", text: `Step ${k + 1}` }, k,
      { summary: `Cluster contains 1 board element with 1 extracted text item. Extracted text highlights: "Step ${k + 1}".` });
  }
  for (let k = 0; k < (options.imageClusters ?? 0); k++) {
    single(`4:${k}`, { name: "Image", type: "RECTANGLE", imageRef: `image-${k}` }, k, {
      summary: "Cluster contains 1 board element with 0 extracted text items. No readable text was extracted from this cluster.",
      incomplete: true, fallbackReason: "time_budget",
    });
  }
  return { boardId, fileKey: boardId, docStructureHint: "freeform", createdAt: 1, snapshotId: "c".repeat(64), nodes, clusters };
}

/**
 * One synthetic table in one section, with cell IDs in the REST API form
 * T<table ID>;<row ID>;<column ID> and no recorded rows or columns.
 */
export function tableBoard(boardId: string, rows = 24, columns = 17): BoardData {
  const page: NormalizedNode = { id: "0:1", name: "Results", type: "CANVAS", x: 0, y: 0, width: 0, height: 0, rotation: 0 };
  const section: NormalizedNode = { id: "1:1", name: "Survey results", type: "SECTION", x: 0, y: 0, width: 4000, height: 2000, rotation: 0, pageId: page.id };
  const cells = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => ({
    id: `T5:1;6:${row};7:${column}`,
    text: row === 0 ? `Metric ${column + 1}` : column === 0 ? `Participant ${row}` : String((row * 37 + column * 11) % 100),
  }))).flat();
  const table: NormalizedNode = {
    id: "5:1", name: "Table 1", type: "TABLE", text: cells.map((cell) => cell.text).join("\n"), x: 100, y: 100, width: 3400, height: 1200,
    rotation: 0, pageId: page.id, sectionIds: [section.id], renderNodeId: "5:1", table: { cells },
  };
  return {
    boardId, fileKey: boardId, docStructureHint: "freeform", createdAt: 1, snapshotId: "d".repeat(64),
    nodes: [page, section, table],
    clusters: [{
      id: "cluster_table", label: "Table 1", nodeIds: [table.id], confirmedNodeIds: [table.id],
      boundingBox: { x: 100, y: 100, width: 3400, height: 1200 }, summarySource: "deterministic",
      summary: `Cluster contains 1 board element with ${cells.length} extracted text items.`,
    }],
  };
}
