import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { flattenNodeTree } from "../src/lib/nodeTree.js";
import { diffBoards } from "../src/lib/boardDiff.js";
import { diffBoard } from "../src/tools/diffBoard.js";
import { EXTRACTION_VERSION, buildBoardCacheKey, hashClusterNodes, hashNormalizedNodes, persistBoard, readBoardHistory } from "../src/lib/persistentCache.js";
import type { BoardData, NormalizedNode } from "../src/types.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "figjam-protected-fingerprint-"));
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", directory);
  vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "true");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function tree(pin: string, table = false) {
  const text = `PIN: ${pin}`;
  const cells = [
    { id: "header", name: "Passwort", type: "TABLE_CELL", rowIndex: 0, columnIndex: 1, characters: "Passwort" },
    { id: "value", name: pin, type: "TABLE_CELL", rowIndex: 1, columnIndex: 1, children: [
      { id: "nested", name: pin, type: "TEXT", characters: pin },
    ] },
  ];
  return { document: { id: "doc", name: "Document", type: "DOCUMENT", children: [table
    ? { id: "source", name: "Table", type: "TABLE", children: cells }
    : { id: "source", name: text, type: "STICKY", characters: text },
  ] } };
}
function board(nodes: NormalizedNode[], createdAt = 1): BoardData {
  return {
    boardId: "SyntheticPin", fileKey: "SyntheticPin", docStructureHint: "freeform", ingestMode: "max_speed",
    extractionVersion: EXTRACTION_VERSION, createdAt, freshnessCheckedAt: createdAt + 1, nodes,
    cacheKey: buildBoardCacheKey({ fileKey: "SyntheticPin", nodeHash: hashNormalizedNodes(nodes), docStructureHint: "freeform", ingestMode: "max_speed" }),
    clusters: [{ id: "cluster", nodeIds: ["source"], confirmedNodeIds: ["source"],
      label: "Credentials", summary: nodes[0]?.text ?? "", contentHash: hashClusterNodes(nodes),
      summarySource: "deterministic", boundingBox: { x: 0, y: 0, width: 100, height: 100 } }],
  };
}

describe("redacted content fingerprints", () => {
  it("hashes only sanitized text when a table credential spans text descendants", () => {
    const splitCell = (value: string) => ({ document: { id: "doc", name: "Document", type: "DOCUMENT", children: [{
      id: "table", name: "Table", type: "TABLE", children: [{
        id: "cell", name: "Cell", type: "TABLE_CELL", children: [
          { id: "label", name: "Password:", type: "TEXT", characters: "Password:" },
          { id: "secret", name: value, type: "TEXT", characters: value },
        ],
      }],
    }] } });
    const before = flattenNodeTree(splitCell("Summer2026!"));
    const after = flattenNodeTree(splitCell("Winter2027?"));
    const alreadyRedacted = flattenNodeTree(splitCell("[redacted]"));
    expect(before[0]?.table?.cells[0]?.text).toBe("Password:\n[redacted]");
    expect(after).toEqual(before);
    expect(alreadyRedacted).toEqual(before);
  });

  it.each([false, true])("stores no fingerprint derived from an unredacted PIN (table=%s)", async table => {
    const original = tree("4711", table);
    vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "false");
    const raw = flattenNodeTree(original);
    vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "true");
    const sanitized = flattenNodeTree(original);
    expect(sanitized[0]?.contentFingerprint).not.toBe(raw[0]?.contentFingerprint);
    await persistBoard(board(sanitized));
    const files = await readdir(path.join(directory, "v4"));
    const bytes = (await Promise.all(files.filter(file => file.endsWith(".json"))
      .map(file => readFile(path.join(directory, "v4", file), "utf8")))).join("\n");
    for (const fingerprint of [raw[0]!.contentFingerprint!, hashNormalizedNodes(raw), hashClusterNodes(raw)]) {
      expect(bytes).not.toContain(fingerprint);
    }
    expect(bytes).not.toContain(table ? '"text":"4711"' : "PIN: 4711");
  });

  it.each([false, true])("keeps fingerprints, cache identity and diff unchanged for a redacted-only edit (table=%s)", async table => {
    const before = flattenNodeTree(tree("4711", table));
    const after = flattenNodeTree(tree("8812", table));
    expect(after).toEqual(before);
    expect(hashNormalizedNodes(after)).toBe(hashNormalizedNodes(before));
    expect(hashClusterNodes(after)).toBe(hashClusterNodes(before));
    expect(diffBoards(board(before), board(after)).stats.editedNodes).toBe(0);
    await persistBoard(board(before));
    await persistBoard(board(after, 2));
    expect(await readBoardHistory("SyntheticPin")).toHaveLength(1);
    const diff = await diffBoard({ boardId: "SyntheticPin", compareTo: 1 });
    expect(diff.stats).toMatchObject({ editedNodes: 0, modifiedClusters: 0 });
    expect(diff.nodeChanges).toEqual([]);
    expect(diff.summaryText).not.toContain("appearance changed");
  });
});
