import { mkdtemp, readFile, writeFile, readdir, stat, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  it("atomically publishes a validated board with separate source and refinement files", async () => {
    const c = await import("../src/lib/persistentCache.js");
    const input = board();
    await expect(c.readLatestBoard(input.fileKey)).resolves.toBeUndefined();
    await c.persistBoard(input);
    const restored = await c.readLatestBoard(input.fileKey);
    expect(restored).toMatchObject({ schemaVersion: 4, nodes: input.nodes, clusters: input.clusters, createdAt: 1 });
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
    await expect(getBoardOrRestore("AbC123", "missing-snapshot")).rejects.toThrow(/Snapshot is no longer available/);
  });
  it("hashes content, table cells, provider and prompt configuration deterministically", async () => {
    const c = await import("../src/lib/persistentCache.js");
    const node = board().nodes[0]!;
    expect(c.hashNormalizedNodes([node])).toBe(c.hashNormalizedNodes([{ ...node, text: "Original" }]));
    expect(c.hashClusterNodes([{ ...node, table: { cells: [{ id: "cell", text: "100" }] } }])).not.toBe(c.hashClusterNodes([{ ...node, table: { cells: [{ id: "cell", text: "999" }] } }]));
    const signature = c.getRefinementSignature(); process.env.LLM_BASE_URL = "https://new-provider.example";
    expect(c.getRefinementSignature()).not.toBe(signature);
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

  it("serializes independent processes publishing to the same board without lost history", async () => {
    const source = new URL("../src/lib/persistentCache.ts", import.meta.url).href;
    const run = promisify(execFile);
    await Promise.all(["left", "right"].map(worker => run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
      `import { persistBoard } from ${JSON.stringify(source)};
       const base = ${JSON.stringify(board())};
       for (let i=0;i<5;i++) {
         const text=${JSON.stringify(worker)}+i;
         await persistBoard({...base, cacheKey:text, nodes:[{...base.nodes[0],text}], createdAt:Date.now()});
       }`], { env: { ...process.env, FIGJAM_MCP_CACHE_DIR: root }, timeout: 20_000 })));
    const cache = await import("../src/lib/persistentCache.js");
    const history = await cache.readBoardHistory("AbC123");
    expect(history).toHaveLength(10);
    expect(new Set(history.map(entry => entry.cacheKey)).size).toBe(10);
    expect(await cache.readLatestBoard("AbC123")).toBeDefined();
  }, 25_000);
});
