import { describe, expect, it } from "vitest";
import { retrieveEvidence } from "../src/lib/evidence.js";
import { retrievalFixtures } from "./fixtures/retrieval.js";
import { changeFixtures } from "./fixtures/changes.js";
import { diffBoards } from "../src/lib/boardDiff.js";

describe("synthetic retrieval quality gate (20 fixtures)", () => {
  it("keeps the declared evaluation corpus complete", () => expect(retrievalFixtures).toHaveLength(20));
  it.each(retrievalFixtures)("$name", ({ board, query, expectedNodeId }) => {
    const result = retrieveEvidence(board, { query, limit: 3 });
    if (expectedNodeId) {
      // Top-1 accuracy on these known, lexical source facts; all returned evidence is traceable.
      expect(result.evidence[0]?.nodeId).toBe(expectedNodeId);
      expect(result.evidence.every((item) => item.snapshotId === board.snapshotId && item.url.includes(board.fileKey))).toBe(true);
    } else {
      expect(result.evidence).toEqual([]);
      expect(result.totalMatched).toBe(0);
    }
  });
});

describe("synthetic revision quality gate (20 paired boards)", () => {
  it("covers each retrieval board with a declared change", () => {
    expect(changeFixtures.map((fixture) => fixture.name)).toEqual(retrievalFixtures.map((fixture) => fixture.name));
    expect(new Set(changeFixtures.map((fixture) => fixture.kind)).size).toBe(5);
  });
  it.each(changeFixtures)("detects the expected revision: $name / $kind", ({ before, after, expected, changedCellId }) => {
    const result = diffBoards(before, after);
    const { tableCellChanges, ...stats } = expected;
    expect(result.stats).toMatchObject(stats);
    expect(result.tableCellChanges).toHaveLength(tableCellChanges);
    if (changedCellId) expect(result.tableCellChanges[0]).toMatchObject({ cellId: changedCellId, changeType: "modified" });
  });
});
