import { describe, expect, it } from "vitest";
import { evidenceTokens, retrieveEvidence } from "../src/lib/evidence.js";
import { evidenceBoard, textNode } from "./fixtures/retrieval.js";

const autoNamed = (id: string, text: string) => ({ ...textNode(id, text), name: text.replace(/\s+/g, " ") });

describe("field-aware source ranking", () => {
  it.each(["text", "node", "section", "page", "cluster"])("uses the weaker length penalty in %s", (field) => {
    const values = ["anchorword", "anchorword anchorword detail detail detail detail", "background ".repeat(10)];
    const board = evidenceBoard("LengthPenalty", values.map((value, i) => textNode(`n:${i}`, field === "text" ? `common ${value}` : "common")));
    values.forEach((value, i) => {
      const node = board.nodes[i]!;
      if (field === "node") node.name = value;
      if (field === "cluster") board.clusters[i]!.label = value;
      if (field === "section" || field === "page") {
        const id = `container:${i}`;
        board.nodes.push({ ...textNode(id, ""), name: value, type: field === "section" ? "SECTION" : "CANVAS", sectionIds: [] });
        if (field === "section") node.sectionIds = [id];
        else node.pageId = id;
      }
    });
    expect(retrieveEvidence(board, { query: "common anchorword" }).evidence[0]!.nodeId).toBe("n:1");
  });

  it("prefers broader coverage to repeated matches and counts each query term only once", () => {
    const board = evidenceBoard("Coverage", [
      textNode("narrow", "alpha ".repeat(20)),
      textNode("broad", "alpha beta " + "detail ".repeat(6)),
      ...Array.from({ length: 20 }, (_, i) => textNode(`noise:${i}`, "beta")),
    ]);
    const ids = (query: string) => retrieveEvidence(board, { query }).evidence.map((item) => item.nodeId);
    expect(ids("alpha beta").slice(0, 2)).toEqual(["broad", "narrow"]);
    expect(ids("alpha alpha alpha beta the and")).toEqual(ids("alpha beta"));
    // One distinct word has full coverage for every original match.
    expect(ids("alpha")).toEqual(["narrow", "broad"]);
    expect(ids("alpha alpha the")).toEqual(ids("alpha"));
  });

  it("counts exact and compound matches across text, node and section once per query word", () => {
    const board = evidenceBoard("FieldCoverage", [
      { ...textNode("repeat", "sensor sensor sensor"), name: "sensor", sectionIds: ["s:1"] },
      { ...textNode("broad", "sensorwartung " + "detail ".repeat(12)), name: "calibration", sectionIds: ["s:2"] },
    ]);
    board.nodes.push(
      { ...textNode("s:1", ""), type: "SECTION", name: "sensor", sectionIds: [] },
      { ...textNode("s:2", ""), type: "SECTION", name: "inspection", sectionIds: [] },
    );
    expect(retrieveEvidence(board, { query: "sensor calibration inspection" }).evidence[0]!.nodeId).toBe("broad");
  });

  it.each(["page", "cluster"])("does not count %s as query coverage", (field) => {
    const board = evidenceBoard("ExcludedCoverage", [
      textNode("narrow", "alpha"), textNode("broad", "alpha beta gamma " + "detail ".repeat(20)),
      ...Array.from({ length: 20 }, (_, i) => textNode(`noise:${i}`, "beta gamma")),
    ]);
    if (field === "cluster") board.clusters[0]!.label = "beta gamma";
    else {
      board.nodes[0]!.pageId = "p:1";
      board.nodes.push({ ...textNode("p:1", ""), type: "CANVAS", name: "beta gamma", sectionIds: [] });
    }
    expect(retrieveEvidence(board, { query: "alpha beta gamma" }).evidence[0]!.nodeId).toBe("broad");
  });

  it("retrieves a compound task among long auto-named instructions without a helpful short name", () => {
    const task = autoNamed("task", "Prüfraumverfügbarkeit klären");
    const board = evidenceBoard("CompoundTask", [
      ...Array.from({ length: 12 }, (_, i) => autoNamed(`noise:${i}`,
        `Prüfraum starten. Die Anleitung sagt, dass alle denselben Ablauf nutzen. ${"Allgemeine Hinweise zur Durchführung. ".repeat(100)} Ende.`)),
      autoNamed("filler", "Wir nutzen das bereits täglich und wissen, dass es klappt."),
      task,
    ]);
    const result = retrieveEvidence(board, {
      query: "Ist laut Board bereits bestätigt, dass der Prüfraum gebucht ist?", limit: 6, includeNeighbors: true,
    });
    const rank = result.evidence.findIndex((item) => item.nodeId === task.id);
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(3);
    expect(result.primaryEvidenceIds).toContain(result.evidence[rank]!.evidenceId);
    expect(result.evidence.some((item) => item.nodeId === "filler")).toBe(false);
    expect(result.evidence[rank]).toMatchObject({ text: task.text, sourceType: "board_text", modelDerived: false });
  });

  it("does not give tiny trailing chunks matches copied from an automatic node name", () => {
    const body = `Anchorword appears here. ${"Ordinary background information. ".repeat(200)} End.`;
    const board = evidenceBoard("AutoNameChunks", [autoNamed("long", body)]);
    const result = retrieveEvidence(board, { query: "anchorword", limit: 6 });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.text).toContain("Anchorword");
    expect(result.evidence[0]!.chunkIndex).toBe(0);
  });

  it("normalizes node-name matches by name length, not by the quoted text length", () => {
    const board = evidenceBoard("FieldLengths", [
      { ...textNode("long-name", "Tiny"), name: `Anchorword ${"unrelated ".repeat(200)}` },
      { ...textNode("short-name", "The responsible team provides the full operational description. ".repeat(20)), name: "Anchorword owner" },
    ]);
    const result = retrieveEvidence(board, { query: "anchorword", limit: 1 });
    expect(result.evidence[0]!.nodeId).toBe("short-name");
    expect(result.evidence[0]!.text).toContain("responsible team");
  });

  it("keeps original section/page discovery without separate page or section excerpts", () => {
    const board = evidenceBoard("OriginalScope", [{ ...textNode("value", "42"), name: "Count" }]);
    board.nodes.push(
      { ...textNode("0:1", ""), type: "CANVAS", name: "Operations", sectionIds: [] },
      { ...textNode("1:0", ""), type: "SECTION", name: "Participants", sectionIds: [] },
    );
    for (const query of ["Count", "Participants", "Operations", "STICKY"]) {
      expect(retrieveEvidence(board, { query }).evidence.some((item) => item.nodeId === "value" && item.text === "42")).toBe(true);
    }
    expect(retrieveEvidence(board).evidence.some((item) => item.nodeId === "1:0" || item.nodeId === "0:1")).toBe(false);
  });

  it("uses cluster labels only to boost existing source matches", () => {
    const board = evidenceBoard("LabelBoost", [textNode("a", "Alpha finding"), textNode("b", "Alpha finding")]);
    board.clusters[0]!.label = "Other";
    board.clusters[1]!.label = "Krypton";
    expect(retrieveEvidence(board, { query: "krypton" }).evidence).toEqual([]);
    expect(retrieveEvidence(board, { query: "alpha krypton" }).evidence[0]!.nodeId).toBe("b");
  });

  it("removes generic question fillers without changing original source text", () => {
    expect(evidenceTokens("laut bereits dass")).toEqual([]);
    const board = evidenceBoard("FillerQuery", [textNode("a", "Das ist laut Plan bereits bestätigt, dass die Freigabe vorliegt.")]);
    expect(retrieveEvidence(board, { query: "laut bereits dass" }).evidence).toEqual([]);
    expect(retrieveEvidence(board, { query: "Freigabe" }).evidence[0]!.text).toBe(board.nodes[0]!.text);
  });
});

describe("bounded compound prefixes", () => {
  it("matches long Latin word beginnings, retaining the original compound", () => {
    const board = evidenceBoard("CompoundPrefix", [textNode("a", "Simulatorverfügbarkeit klären")]);
    expect(retrieveEvidence(board, { query: "Simulator" }).evidence[0]).toMatchObject({ nodeId: "a", text: "Simulatorverfügbarkeit klären" });
    expect(retrieveEvidence(board, { query: "verfügbarkeit" }).evidence).toEqual([]);
  });

  it.each([
    ["apple", "pineapple"], ["sens", "sensorwartung"], ["sensor", "sensoren"],
    ["E731", "E731extension"], ["sensor7", "sensor7wartung"], ["EU", "european"],
  ])("keeps %s from partially matching %s", (query, word) => {
    expect(retrieveEvidence(evidenceBoard("PrefixBoundary", [textNode("a", word)]), { query }).evidence).toEqual([]);
  });

  it("caps deterministic prefix expansion at 32 terms and always retains exact matches", () => {
    const suffix = (i: number) => `a${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + i % 26)}`;
    // The cap is shared by source text and metadata, not multiplied per field.
    const nodes = Array.from({ length: 40 }, (_, i) => i % 2 === 0
      ? textNode(`compound:${i}`, `sensor${suffix(i)}`)
      : { ...textNode(`compound:${i}`, "Unrelated source detail"), name: `sensor${suffix(i)}` }).reverse();
    nodes.push(textNode("exact", "sensor"));
    const result = retrieveEvidence(evidenceBoard("PrefixCap", nodes), { query: "sensor" });
    expect(result.evidence).toHaveLength(33);
    expect(new Set(result.evidence.map((item) => item.nodeId))).toEqual(new Set([
      "exact", ...Array.from({ length: 32 }, (_, i) => `compound:${i}`),
    ]));
  });
});
