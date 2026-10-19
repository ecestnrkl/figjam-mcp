import type { BoardData, NormalizedNode, RefinedCluster } from "../../src/types.js";

/**
 * Synthetic workshop board: stickies are named after their text as FigJam does,
 * frames and vectors mostly keep default names, and clusters carry deterministic
 * summaries in the ingest_board format.
 */
export function largeBoard(boardId: string, clusterCount = 300, stickiesPerCluster = 10, sectionCount = 12): BoardData {
  const page: NormalizedNode = { id: "0:1", name: "Workshop", type: "CANVAS", x: 0, y: 0, width: 0, height: 0, rotation: 0 };
  const sections: NormalizedNode[] = Array.from({ length: sectionCount }, (_, index) => ({
    id: `1:${index}`, name: `Theme ${index + 1}`, type: "SECTION", x: 0, y: 0, width: 0, height: 0, rotation: 0, pageId: page.id,
  }));
  const nodes: NormalizedNode[] = [page, ...sections];
  const clusters: RefinedCluster[] = [];
  for (let c = 0; c < clusterCount; c++) {
    // Uneven section sizes give the board overview a meaningful order.
    const section = sections[Math.floor(Math.sqrt(c / clusterCount) * sectionCount)]!;
    const stickies = Array.from({ length: stickiesPerCluster }, (_, s): NormalizedNode => {
      const text = `Participant ${c}-${s} said onboarding step ${s} feels slow on mobile.`;
      return {
        id: `${c + 10}:${s}`, name: text, type: "STICKY", text, x: c * 400, y: s * 120, width: 100, height: 100,
        rotation: 0, pageId: page.id, sectionIds: [section.id],
      };
    });
    // Tree order puts containers and drawings before the stickies on them.
    const shape = (id: string, name: string, type: string): NormalizedNode => ({
      id, name, type, x: c * 400, y: 0, width: 300, height: 1200, rotation: 0, pageId: page.id, sectionIds: [section.id],
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
  return { boardId, fileKey: boardId, docStructureHint: "freeform", createdAt: 1, snapshotId: "c".repeat(64), nodes, clusters };
}
