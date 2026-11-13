import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fileTree } = vi.hoisted(() => ({ fileTree: vi.fn() }));
vi.mock("../src/lib/figmaApi.js", async original => ({
  ...(await original<typeof import("../src/lib/figmaApi.js")>()), fetchFileTree: fileTree,
}));

// These artifacts were written by untouched origin/main, not by the reader under test.
const fixture = JSON.parse(await readFile(new URL("./fixtures/pre012Cache.json", import.meta.url), "utf8")) as {
  fileKey: string;
  rawTree: unknown;
  files: Record<string, unknown>;
};
let directory: string;
beforeEach(async () => {
  vi.resetModules();
  fileTree.mockReset();
  directory = await mkdtemp(path.join(tmpdir(), "figjam-pre012-cache-"));
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", directory);
  vi.stubEnv("FIGMA_ACCESS_TOKEN", "synthetic-offline");
  vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "true");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live requests are forbidden in this test"); }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await mkdir(path.join(directory, "v4"));
  await Promise.all(Object.entries(fixture.files).map(([name, contents]) =>
    writeFile(path.join(directory, "v4", name), JSON.stringify(contents))));
  fileTree.mockResolvedValue(structuredClone(fixture.rawTree));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

describe("pre-0.12 snapshot compatibility with real persistence", () => {
  it("reads a main-generated v6 cache through get_board_context without another ingest", async () => {
    const { getBoardContext } = await import("../src/tools/getBoardContext.js");
    const { readLatestBoard, hashNormalizedNodes } = await import("../src/lib/persistentCache.js");
    const { structuredContent } = await getBoardContext({ boardId: fixture.fileKey, detail: "full" });
    expect(structuredContent.evidence.map(item => item.nodeId)).toEqual(["12:30", "123:4", "19:5", "198:6"]);
    const restored = (await readLatestBoard(fixture.fileKey))!;
    expect(restored.extractionVersion).toBe(6);
    // This fixture actually distinguishes historical locale order from code-unit order.
    expect(restored.nodeHash).not.toBe(hashNormalizedNodes(restored.nodes));
    expect(fileTree).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports no changes after ingesting the same v6 fixture content with v7", async () => {
    const { ingestBoard } = await import("../src/tools/ingestBoard.js");
    const { diffBoard } = await import("../src/tools/diffBoard.js");
    const { readLatestBoard, readBoardHistory } = await import("../src/lib/persistentCache.js");
    const result = await ingestBoard({
      figmaFileUrl: `https://www.figma.com/board/${fixture.fileKey}/Fixture`,
      docStructureHint: "freeform", ingestMode: "max_speed",
    });
    expect((await readLatestBoard(fixture.fileKey))?.extractionVersion).toBe(8);
    const history = await readBoardHistory(fixture.fileKey);
    expect(history).toHaveLength(2);
    expect(history[0]?.snapshotId).not.toBe(result.snapshotId);
    const diff = await diffBoard({ boardId: fixture.fileKey, compareTo: 1 });
    const { unchangedClusters, ...changes } = diff.stats;
    expect(unchangedClusters).toBe(1);
    expect(Object.values(changes).every(count => count === 0)).toBe(true);
    expect(diff.nodeChanges).toEqual([]);
    expect(diff.tableCellChanges).toEqual([]);
    expect(fileTree).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("writes code-unit identities even when given a restored legacy nodeHash", async () => {
    const { readLatestBoard, persistBoard, hashNormalizedNodes } = await import("../src/lib/persistentCache.js");
    const legacy = (await readLatestBoard(fixture.fileKey))!;
    expect(legacy.extractionVersion).toBe(6);
    vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("New snapshots must not use localeCompare");
    });
    await persistBoard({ ...legacy, cacheKey: "rewritten", createdAt: Date.now() });
    const written = (await readLatestBoard(fixture.fileKey))!;
    expect(written.extractionVersion).toBe(8);
    expect(written.nodeHash).toBe(hashNormalizedNodes(written.nodes));
    expect(written.nodeHash).not.toBe(legacy.nodeHash);
    expect(console.error).not.toHaveBeenCalled();
  });
});
