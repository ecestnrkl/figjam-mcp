import type { BoardData, NormalizedNode, RefinedCluster } from "../../src/types.js";

export const OVERVIEW_SECTION_IDS = Array.from({ length: 8 }, (_, index) => `1:${index}`);
export const OVERVIEW_NESTED_SECTION_ID = "2:0";
export const OVERVIEW_TABLE_ID = "40:0";
export const OVERVIEW_MODEL_ID = "50:0";
export const OVERVIEW_METADATA_ID = "60:0";
export const OVERVIEW_LONG_ID = "12:0";

export interface OverviewBoardOptions {
  notesPerSection?: number;
  /** Keeps the fixture deterministic while exercising escaping and byte budgets. */
  noteText?: (section: number, index: number) => string;
  sectionName?: (section: number) => string;
}

/** Synthetic source data only: eight sections, a nested namesake, rows, chunks and interpretations. */
export function overviewBoard(boardId = "Overview123", options: OverviewBoardOptions = {}): BoardData {
  const box = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
  const pageId = "0:1";
  const nodes: NormalizedNode[] = [{ id: pageId, name: "Synthetic workshop", type: "CANVAS", ...box }];
  const clusters: RefinedCluster[] = [];
  const cluster = (id: string, members: NormalizedNode[], summary = "", summarySource: RefinedCluster["summarySource"] = "deterministic") => {
    nodes.push(...members);
    clusters.push({ id, label: `Synthetic area ${id}`, nodeIds: members.map((node) => node.id),
      confirmedNodeIds: members.map((node) => node.id), boundingBox: { x: 0, y: 0, width: 100, height: 100 },
      summary, summarySource });
  };
  for (let section = 0; section < 8; section++) {
    const id = OVERVIEW_SECTION_IDS[section]!;
    nodes.push({ id, name: options.sectionName?.(section) ?? (section < 2 ? "Shared theme" : `Theme ${section + 1}`),
      type: "SECTION", ...box, x: section * 4000, pageId });
  }
  nodes.push({ id: OVERVIEW_NESTED_SECTION_ID, name: "Shared theme", type: "SECTION", ...box,
    y: 4000, pageId, parentId: "1:0", sectionIds: ["1:0", OVERVIEW_NESTED_SECTION_ID] });
  nodes.push({ id: "3:0", name: "Frame 1", type: "FRAME", ...box, pageId, parentId: "1:0", sectionIds: ["1:0"] });
  nodes.push({ id: "3:1", name: "Group 1", type: "GROUP", ...box, pageId, parentId: "1:1", sectionIds: ["1:1"] });
  for (let section = 0; section < 8; section++) {
    const count = options.notesPerSection ?? 28;
    const members = Array.from({ length: count }, (_, index): NormalizedNode => {
      const nested = section === 0 && index >= count - 4;
      const sectionIds = nested ? ["1:0", OVERVIEW_NESTED_SECTION_ID] : [OVERVIEW_SECTION_IDS[section]!];
      const parentId = nested ? OVERVIEW_NESTED_SECTION_ID : section === 0 ? "3:0" : section === 1 ? "3:1" : sectionIds[0];
      let text = options.noteText?.(section, index) ?? `Idea ${section}-${index}: less waiting.`;
      if (!options.noteText && section === 2 && index < 3) {
        text = `Long paragraph ${index}. ` + "Preserve the original wording and the full source for careful reading. ".repeat(35);
      }
      if (!options.noteText && section === 5 && index === 0) text = "First line\n\tsecond   line";
      if (!options.noteText && section === 5 && index === 1) text = "API key: synthetic-credential-123\nPublic follow-up.";
      if (!options.noteText && section === 6 && index < 2) text = "The same proposal.";
      return { id: `${section + 10}:${index}`, name: text, type: "STICKY", text, ...box,
        x: section * 4000 + (index % 4) * 100, y: Math.floor(index / 4) * 120, pageId, sectionIds, parentId };
    });
    cluster(`notes_${section}`, members);
  }
  const cells = Array.from({ length: 14 }, (_, index) => ({
    id: `T${OVERVIEW_TABLE_ID};41:${Math.floor(index / 2)};42:${index % 2}`,
    row: Math.floor(index / 2), column: index % 2,
    text: index < 2 ? ["Measure", "Value"][index]! : index % 2 ? "Same value" : "Repeated row",
  }));
  cluster("table", [{ id: OVERVIEW_TABLE_ID, name: "Table 1", type: "TABLE", ...box, pageId,
    sectionIds: ["1:3"], parentId: "1:3", renderNodeId: OVERVIEW_TABLE_ID,
    text: cells.map((cell) => cell.text).join("\n"), table: { cells } }]);
  const image: NormalizedNode = { id: OVERVIEW_MODEL_ID, name: "Image", type: "RECTANGLE", imageRef: "synthetic-image",
    ...box, pageId, sectionIds: ["1:4"], parentId: "1:4" };
  cluster("image", [image], "A model interprets this synthetic drawing as a progress indicator.", "vision_llm");
  clusters.push({ ...clusters.at(-1)!, id: "image_second", summarySource: "text_llm" });
  cluster("metadata", [{ id: OVERVIEW_METADATA_ID, name: "Review badge", type: "VECTOR", ...box,
    pageId, sectionIds: ["1:5"], parentId: "1:5" }]);
  cluster("outside", [{ id: "70:0", name: "Outside note", type: "STICKY", text: "An outside observation.", ...box, pageId }]);
  nodes.push({ id: "71:0", name: "Rectangle", type: "RECTANGLE", ...box, pageId });
  return { boardId, fileKey: boardId, docStructureHint: "freeform", createdAt: 1,
    snapshotId: "e".repeat(64), nodes, clusters };
}
