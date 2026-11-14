import { mkdtemp, readFile, writeFile, readdir, stat, mkdir, rm, chmod, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardData } from "../src/types.js";
const original = { ...process.env };
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "figjam-v4-")); process.env.FIGJAM_MCP_CACHE_DIR = root; vi.resetModules(); });
afterEach(async () => { process.env = { ...original }; vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
function board(text = "Original", name = "AbC123"): BoardData {
  return { boardId: name, fileKey: name, docStructureHint: "freeform", cacheKey: `key-${text.replace(/\W/g, "")}`,
    nodes: [{ id: "1:1", name: "Sticky", type: "STICKY", x: 0, y: 0, width: 100, height: 100, rotation: 0, text }],
    clusters: [{ id: "c1", nodeIds: ["1:1"], confirmedNodeIds: ["1:1"], label: "Notes", summary: text, summarySource: "vision_llm", incomplete: false, boundingBox: { x: 0, y: 0, width: 100, height: 100 } }],
    createdAt: 1 };
}
describe("v4 persistence", () => {
  it("resolves a home-relative cache directory when persistence is needed", async () => {
    vi.doMock("node:os", async (importOriginal) => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => root }));
    try {
      const cache = await import("../src/lib/persistentCache.js");
      process.env.FIGJAM_MCP_CACHE_DIR = "~/private-cache";
      await cache.persistBoard(board());
      expect(await readdir(path.join(root, "private-cache", "v4"))).toContain("board-AbC123.json");
      expect((await cache.readLatestBoard("AbC123"))?.nodes[0]?.text).toBe("Original");
    } finally {
      vi.doUnmock("node:os");
    }
  });

  it("atomically publishes a validated board with separate source and refinement files", async () => {
    const c = await import("../src/lib/persistentCache.js");
    const input = board();
    await expect(c.readLatestBoard(input.fileKey)).resolves.toBeUndefined();
    await c.persistBoard(input);
    const restored = await c.readLatestBoard(input.fileKey);
    expect(restored).toMatchObject({ schemaVersion: 4, extractionVersion: 8, nodes: input.nodes, clusters: input.clusters, createdAt: 1 });
    const names = await readdir(path.join(root, "v4"));
    expect(names.some(n => n.startsWith("source-"))).toBe(true);
    expect(names.some(n => n.endsWith(".tmp"))).toBe(false);
    const entry = (await c.readBoardHistory(input.fileKey))[0]!;
    const derived = JSON.parse(await readFile(path.join(root, "v4", `refinement-${entry.refinementId}.json`), "utf8"));
    expect(derived.derived.nodes).toBeUndefined();
    expect(await c.readBoardSnapshot(input.fileKey, restored!.snapshotId!)).toEqual(restored);
    if (process.platform !== "win32") {
      expect((await stat(path.join(root, "v4"))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(root, "v4", `refinement-${entry.refinementId}.json`))).mode & 0o777).toBe(0o600);
    }
  });
  it("deduplicates source states when only the model or summary changes", async () => {
    const c = await import("../src/lib/persistentCache.js");
    await c.persistBoard(board());
    await c.persistBoard({ ...board(), cacheKey: "another-model", createdAt: 99, clusters: [{ ...board().clusters[0]!, summary: "Better summary" }] });
    const history = await c.readBoardHistory("AbC123");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ cacheKey: "another-model", createdAt: 1 });
  });
  it.each([undefined, 4])("preserves historical extraction %s snapshots beside the new extraction", async (extractionVersion) => {
    const c = await import("../src/lib/persistentCache.js");
    const input = board();
    const nodeHash = c.hashNormalizedNodes(input.nodes);
    const snapshotId = c.buildSnapshotId(input.fileKey, nodeHash, 4);
    const legacy = { ...input, schemaVersion: 4, extractionVersion, snapshotId, nodeHash };
    const { nodes, connectorEdges, ...derived } = legacy;
    const source = JSON.stringify({ schemaVersion: 4, extractionVersion, snapshotId, fileKey: input.fileKey, nodes, connectorEdges });
    const refinement = JSON.stringify({ schemaVersion: 4, revisionId: "legacy", snapshotId, derived });
    const directory = path.join(root, "v4");
    await mkdir(directory);
    await writeFile(path.join(directory, `source-${snapshotId}.json`), source);
    await writeFile(path.join(directory, "refinement-legacy.json"), refinement);
    await writeFile(path.join(directory, `board-${input.fileKey}.json`), JSON.stringify({ schemaVersion: 4,
      latest: input.cacheKey, latestRevision: "legacy", history: [{ cacheKey: input.cacheKey, refinementId: "legacy", snapshotId, nodeHash, createdAt: 1 }] }));
    const historical = await c.readLatestBoard(input.fileKey);
    expect(historical).toMatchObject({ extractionVersion: 4, snapshotId, nodes: input.nodes });
    await c.persistBoard({ ...input, cacheKey: "new-extraction", createdAt: 2 });
    const current = await c.readLatestBoard(input.fileKey);
    expect(current).toMatchObject({ extractionVersion: 8, createdAt: 2 });
    expect(current?.snapshotId).not.toBe(snapshotId);
    expect(await c.readBoardHistory(input.fileKey)).toHaveLength(2);
    expect(await c.readBoardSnapshot(input.fileKey, snapshotId)).toEqual(historical);
    expect(await readFile(path.join(directory, `source-${snapshotId}.json`), "utf8")).toBe(source);
    expect(await readFile(path.join(directory, "refinement-legacy.json"), "utf8")).toBe(refinement);
  });
  it("rejects mismatched extraction versions and hashes instead of changing source identity", async () => {
    const c = await import("../src/lib/persistentCache.js");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await c.persistBoard(board());
    const current = (await c.readLatestBoard("AbC123"))!;
    const entry = (await c.readBoardHistory("AbC123"))[0]!;
    const sourcePath = path.join(root, "v4", `source-${current.snapshotId}.json`);
    const refinementPath = path.join(root, "v4", `refinement-${entry.refinementId}.json`);
    const source = JSON.parse(await readFile(sourcePath, "utf8"));
    source.extractionVersion = 4;
    await writeFile(sourcePath, JSON.stringify(source));
    await expect(c.readLatestBoard("AbC123")).resolves.toBeUndefined();
    const refinement = JSON.parse(await readFile(refinementPath, "utf8"));
    refinement.derived.extractionVersion = 4;
    await writeFile(refinementPath, JSON.stringify(refinement));
    await expect(c.readLatestBoard("AbC123")).resolves.toBeUndefined();
  });
  // Each publication flushes real files; shared Windows runners need more than
  // the default five seconds for all 25 serialized publications.
  it("caps history and serializes concurrent publications without losing retained entries", async () => {
    const c = await import("../src/lib/persistentCache.js");
    await Promise.all(Array.from({ length: 25 }, (_, i) => c.persistBoard({ ...board(`Text${i}`), createdAt: i })));
    const history = await c.readBoardHistory("AbC123");
    expect(history).toHaveLength(20);
    expect(history.map(e => e.cacheKey)).toEqual(Array.from({ length: 20 }, (_, i) => `key-Text${i + 5}`));
    expect((await c.readLatestBoard("AbC123"))?.nodes[0]?.text).toBe("Text24");
  }, 25_000);
  it("preserves legacy data and asks for a new ingest instead of silently migrating", async () => {
    const old = JSON.stringify({ schemaVersion: 3, cacheKey: "old" });
    await writeFile(path.join(root, "latest-AbC123.json"), old);
    const c = await import("../src/lib/persistentCache.js");
    await expect(c.readLatestBoard("AbC123")).resolves.toBeUndefined();
    const cache = await import("../src/lib/cache.js");
    await expect(cache.getBoardOrRestore("AbC123")).rejects.toThrow(/cache v3.*ingest_board/);
    await c.persistBoard(board());
    expect(await readFile(path.join(root, "latest-AbC123.json"), "utf8")).toBe(old);
    expect(await c.readBoardHistory("AbC123")).toHaveLength(1);
  });
  it("rejects damaged source, invalid shapes and unsafe keys", async () => {
    const c = await import("../src/lib/persistentCache.js");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await c.persistBoard(board());
    const [source] = (await readdir(path.join(root, "v4"))).filter(n => n.startsWith("source-"));
    await writeFile(path.join(root, "v4", source!), JSON.stringify({ schemaVersion: 4, nodes: "broken" }));
    await expect(c.readLatestBoard("AbC123")).resolves.toBeUndefined();
    await expect(c.readCachedBoard("../../outside")).resolves.toBeUndefined();
    await c.persistBoard(board());
    expect((await c.readLatestBoard("AbC123"))?.nodes).toEqual(board().nodes);
  });
  it("does not publish a canceled snapshot", async () => {
    const c = await import("../src/lib/persistentCache.js");
    await c.persistBoard(board());
    const abort = new AbortController(); abort.abort();
    await expect(c.persistBoard(board("Changed"), abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect((await c.readLatestBoard("AbC123"))?.nodes[0]?.text).toBe("Original");
  });
  it("restores original provenance and capture time", async () => {
    const c = await import("../src/lib/persistentCache.js"); await c.persistBoard(board());
    const { getBoardOrRestore } = await import("../src/lib/cache.js");
    const restored = await getBoardOrRestore("AbC123");
    expect(restored?.createdAt).toBe(1);
    expect(restored?.clusters[0]).toMatchObject({ summarySource: "vision_llm", cacheHit: true });
  });
  it("hashes content, table cells, provider and prompt configuration deterministically", async () => {
    const c = await import("../src/lib/persistentCache.js");
    const node = board().nodes[0]!;
    expect(c.hashNormalizedNodes([node])).toBe(c.hashNormalizedNodes([{ ...node, text: "Original" }]));
    expect(c.hashClusterNodes([{ ...node, table: { cells: [{ id: "cell", text: "100" }] } }])).not.toBe(c.hashClusterNodes([{ ...node, table: { cells: [{ id: "cell", text: "999" }] } }]));
    const signature = c.getRefinementSignature(); process.env.LLM_BASE_URL = "https://new-provider.example";
    expect(c.getRefinementSignature()).not.toBe(signature);
    // Only what decides image interpretations counts; text models do not.
    const vision = c.getRefinementSignature();
    process.env.LLM_TEXT_MODELS = "other/text"; process.env.LLM_FAST_TEXT_MODELS = "other/fast";
    expect(c.getRefinementSignature()).toBe(vision);
    process.env.LLM_PROVIDER_REQUIRE_PARAMETERS = "false";
    expect(c.getRefinementSignature()).not.toBe(vision);
  });
  it("respects another process's cache lock and supports cancellation while waiting", async () => {
    await mkdir(path.join(root, "v4", ".write-lock"), { recursive: true });
    await writeFile(path.join(root, "v4", ".write-lock", "owner.json"), JSON.stringify({ pid: process.pid, token: "other" }));
    const c = await import("../src/lib/persistentCache.js");
    const controller = new AbortController();
    const pending = c.persistBoard(board(), controller.signal);
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await c.readBoardHistory("AbC123")).toEqual([]);
  });

  it("serializes independent server modules publishing to the same board without lost history", async () => {
    const left = await import("../src/lib/persistentCache.js");
    vi.resetModules();
    const right = await import("../src/lib/persistentCache.js");
    await Promise.all([left, right].map(async (cache, worker) => {
      for (let i = 0; i < 5; i++) await cache.persistBoard({ ...board(`Worker${worker}Text${i}`), createdAt: i });
    }));
    const history = await left.readBoardHistory("AbC123");
    expect(history).toHaveLength(10);
    expect(new Set(history.map(entry => entry.cacheKey)).size).toBe(10);
    expect(await right.readLatestBoard("AbC123")).toBeDefined();
  }, 25_000);

  it.each(["manifest", "refinement", "source"])("cleans unrelated artifacts while preserving a damaged %s of another board", async (artifact) => {
    const cache = await import("../src/lib/persistentCache.js");
    await cache.persistBoard(board("Other", "OtherBoard"));
    const other = (await cache.readBoardHistory("OtherBoard"))[0]!;
    const names = await readdir(path.join(root, "v4"));
    const damagedName = artifact === "manifest" ? "board-OtherBoard.json" : artifact === "source"
      ? `source-${other.snapshotId}.json` : `refinement-${other.refinementId}.json`;
    await writeFile(path.join(root, "v4", damagedName), '{"schemaVersion":');
    const orphanNames = [`source-${"a".repeat(64)}.json`, "refinement-orphan.json"];
    for (const name of orphanNames) await writeFile(path.join(root, "v4", name), JSON.stringify({ fileKey: "AbC123" }));
    const old = new Date(Date.now() - 120_000);
    for (const name of [...names, ...orphanNames]) await utimes(path.join(root, "v4", name), old, old);
    await cache.persistBoard(board());
    const remaining = await readdir(path.join(root, "v4"));
    for (const name of names) expect(remaining).toContain(name);
    for (const name of orphanNames) expect(remaining).not.toContain(name);
  });

  it.each([{ age: 3_600_001, retained: false }, { age: 30_000, retained: true }])("collects temporary files only after one hour ($age ms)", async ({ age, retained }) => {
    const cache = await import("../src/lib/persistentCache.js");
    await mkdir(path.join(root, "v4"));
    const filename = path.join(root, "v4", "refinement-abandoned.json.write.tmp");
    await writeFile(filename, "partial");
    const modified = new Date(Date.now() - age);
    await utimes(filename, modified, modified);
    await cache.persistBoard(board());
    expect((await readdir(path.join(root, "v4"))).includes(path.basename(filename))).toBe(retained);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("preserves permissions of an existing user-selected cache directory", async () => {
    const cache = await import("../src/lib/persistentCache.js");
    await chmod(root, 0o750);
    await cache.persistBoard(board());
    expect((await stat(root)).mode & 0o777).toBe(0o750);
  });
});

it.each(["", "   "])("treats blank cache directory settings as unset (%j)", async (value) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  vi.doMock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), homedir: () => root }));
  try {
    process.env.FIGJAM_MCP_CACHE_DIR = value;
    process.env.XDG_CACHE_HOME = value;
    const c = await import("../src/lib/persistentCache.js");
    await c.persistBoard(board());
    expect(await readdir(path.join(root, ".cache", "figjam-context-mcp", "v4"))).toContain("board-AbC123.json");
    process.env.XDG_CACHE_HOME = path.join(root, "xdg");
    await c.persistBoard(board());
    expect(await readdir(path.join(root, "xdg", "figjam-context-mcp", "v4"))).toContain("board-AbC123.json");
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    vi.doUnmock("node:os");
  }
});
