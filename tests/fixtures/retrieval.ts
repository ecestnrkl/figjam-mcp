import type { BoardData, NormalizedNode } from "../../src/types.js";

export function textNode(id: string, text: string): NormalizedNode {
  return { id, name: "Sticky", type: "STICKY", text, x: 0, y: 0, width: 100, height: 100, rotation: 0, pageId: "0:1", sectionIds: ["1:0"] };
}

export function evidenceBoard(boardId = "Evidence123", nodes = [textNode("1:1", "Payment retries require an idempotency key.")]): BoardData {
  return {
    boardId, fileKey: boardId, docStructureHint: "freeform", createdAt: 1,
    snapshotId: "a".repeat(64), nodes,
    clusters: nodes.map((node, index) => ({
      id: `cluster_${index}`, label: `Area ${index + 1}`, summary: "A broad workshop overview that omits specific details.",
      nodeIds: [node.id], confirmedNodeIds: [node.id], summarySource: "deterministic",
      boundingBox: { x: index * 200, y: 0, width: 100, height: 100 },
    })),
  };
}

/** Synthetic, source-grounded relevance cases. No benchmark claim about real user boards. */
export const retrievalFixtures: Array<{ name: string; board: BoardData; query: string; expectedNodeId?: string }> = [
  ["exact engineering term", "Idempotency keys prevent duplicate payment charges.", "payment idempotency"],
  ["German umlaut", "Die Kündigungsfrist beträgt sechs Wochen.", "Kündigungsfrist"],
  ["German compound", "Die Benutzeroberfläche benötigt mehr Kontrast.", "Benutzeroberfläche"],
  ["French accents", "Le délai de rétractation est de quatorze jours.", "rétractation"],
  ["Turkish text", "Ödeme işlemi başarısız olduğunda bildirim gönderilir.", "Ödeme"],
  ["Chinese segmentation", "退款政策要求保留原始收据。", "退款"],
  ["Japanese segmentation", "配送時間は営業日で三日です。", "配送"],
  ["numeric fact", "The trial lasts 37 days before renewal.", "37"],
  ["rare identifier", "Escalate error E731 to the reliability team.", "E731"],
  ["NFKC normalization", "The ＰＡＹＭＥＮＴ reference is mandatory.", "payment"],
  ["case insensitivity", "OAuth callback URLs must match exactly.", "OAUTH"],
  ["negation preserved", "Do not enable automatic renewal for guest accounts.", "renewal"],
  ["email phrase", "Escalations go to support@example.test.", "support@example.test"],
  ["short acronym", "An EU region is mandatory for storage.", "EU"],
].map(([name, text, query], index) => ({
  name: name!, query: query!, expectedNodeId: "1:1",
  board: evidenceBoard(`Fixture${index + 100}`, [
    textNode("1:2", "Unrelated roadmap sketches for the next workshop."),
    textNode("1:1", text!),
  ]),
}));

const longBoard = evidenceBoard("LongText123", [textNode("2:1", "Ordinary workshop detail. ".repeat(150) + "The lunar launch window starts at 06:45 UTC.")]);
retrievalFixtures.push({ name: "fact beyond first chunk", board: longBoard, query: "lunar launch", expectedNodeId: "2:1" });
const sixthBoard = evidenceBoard("SixthNode123", Array.from({ length: 8 }, (_, index) => textNode(`3:${index}`, index === 6 ? "The zephyr budget is EUR 8400." : "Generic interview notes.")));
retrievalFixtures.push({ name: "fact beyond summary highlights", board: sixthBoard, query: "zephyr budget", expectedNodeId: "3:6" });
const tableBoard = evidenceBoard("Table123", [{ ...textNode("4:0", ""), type: "TABLE", table: { cells: [
  { id: "cell-a", text: "Mercury", row: 0, column: 0 }, { id: "cell-b", text: "Retention: 90 days", row: 0, column: 1 },
] } }]);
retrievalFixtures.push({ name: "table cell source", board: tableBoard, query: "retention", expectedNodeId: "cell-b" });
const duplicatedLabels = evidenceBoard("Duplicate123", [textNode("5:1", "Android installation is complete."), textNode("5:2", "iOS provisioning is blocked.")]);
duplicatedLabels.clusters.forEach((cluster) => { cluster.label = "Status"; });
retrievalFixtures.push({ name: "duplicate cluster labels", board: duplicatedLabels, query: "provisioning", expectedNodeId: "5:2" });
retrievalFixtures.push({ name: "unrelated topic stays empty", board: evidenceBoard("NoMatch123"), query: "quantum reactor" });
retrievalFixtures.push({ name: "stopword-only query stays empty", board: evidenceBoard("Stopword123"), query: "the and is" });
