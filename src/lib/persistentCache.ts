import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { BoardData, DocStructureHint, IngestMode, NormalizedNode } from "../types.js";
import { getModelConfigSignature } from "./modelRegistry.js";
import { MAX_BOARD_NODES } from "./nodeTree.js";

export const CACHE_SCHEMA_VERSION = 4;
export const EXTRACTION_VERSION = 4;
export const PROMPT_VERSION = 4;
const defaultRoot = process.platform === "darwin"
  ? path.join(homedir(), "Library", "Caches", "figjam-context-mcp")
  : process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "figjam-context-mcp")
    : path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "figjam-context-mcp");
const CACHE_ROOT = process.env.FIGJAM_MCP_CACHE_DIR ?? defaultRoot;
const CACHE_DIR = path.join(CACHE_ROOT, "v4");
const LEGACY_ROOT = process.env.FIGJAM_MCP_CACHE_DIR ?? path.join(process.cwd(), ".cache", "figjam-mcp");
const HISTORY_LIMIT = 20;
let mutationQueue: Promise<unknown> = Promise.resolve();
const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const finite = z.number().finite();
const nodeSchema = z.object({
  id: z.string(), name: z.string(), type: z.string(), x: finite, y: finite,
  width: finite, height: finite, rotation: finite, text: z.string().optional(),
  imageRef: z.string().optional(), parentId: z.string().optional(), pageId: z.string().optional(),
  sectionIds: z.array(z.string()).optional(), renderNodeId: z.string().optional(),
  contentFingerprint: z.string().optional(),
  connectorStartId: z.string().optional(), connectorEndId: z.string().optional(),
  connectorStartArrowhead: z.string().optional(), connectorEndArrowhead: z.string().optional(),
  table: z.object({ cells: z.array(z.object({ id: z.string(), text: z.string(), row: finite.optional(), column: finite.optional() })) }).optional(),
}).passthrough();
const edgeSchema = z.object({ connectorId: z.string(), fromNodeId: z.string(), toNodeId: z.string(), label: z.string().optional(), direction: z.enum(["forward", "reverse", "bidirectional", "undirected"]).optional() });
const clusterSchema = z.object({
  id: z.string(), nodeIds: z.array(z.string()), confirmedNodeIds: z.array(z.string()),
  label: z.string(), summary: z.string(), phase: z.string().optional(),
  boundingBox: z.object({ x: finite, y: finite, width: finite, height: finite }),
  summarySource: z.enum(["vision_llm", "text_llm", "deterministic", "cache"]).optional(),
  modelId: z.string().optional(), contentHash: z.string().optional(), cacheHit: z.boolean().optional(),
  incomplete: z.boolean().optional(), fallbackReason: z.string().optional(), retryAfter: finite.optional(),
}).passthrough();
const boardSchema = z.object({
  schemaVersion: z.literal(4), snapshotId: key, boardId: key, fileKey: key,
  docStructureHint: z.enum(["freeform", "double_diamond", "lean_canvas", "retro", "user_journey"]),
  nodes: z.array(nodeSchema).max(MAX_BOARD_NODES), clusters: z.array(clusterSchema).max(MAX_BOARD_NODES), createdAt: finite,
  connectorEdges: z.array(edgeSchema).optional(),
  clusterRelations: z.array(z.object({ fromClusterId: z.string(), toClusterId: z.string(), labels: z.array(z.string()), edgeCount: finite })).optional(),
  customPhases: z.array(z.string()).optional(), ingestMode: z.enum(["balanced", "max_quality", "max_speed"]).optional(),
  cacheKey: key.optional(), figmaVersion: z.string().optional(), figmaLastModified: z.string().optional(),
  nodeHash: z.string().optional(), refinementSignature: z.string().optional(), freshnessCheckedAt: finite.optional(),
  qualityReport: z.object({ modelsUsed: z.array(z.string()), cachedClusters: finite, deterministicClusters: finite, visionClusters: finite, fallbackCount: finite, reusedClusters: finite.optional(), incompleteClusters: finite.optional(), fallbackReasons: z.record(z.string(), finite).optional(), nextRetryAt: finite.optional() }).optional(),
}).passthrough();
export interface BoardCacheIdentity { fileKey: string; figmaLastModified?: string; nodeHash: string; docStructureHint: DocStructureHint; customPhases?: string[]; ingestMode: IngestMode }
export interface BoardHistoryEntry { cacheKey: string; refinementId?: string; nodeHash: string; snapshotId?: string; createdAt: number }
const entrySchema = z.object({ cacheKey: key, refinementId: key.optional(), nodeHash: z.string(), snapshotId: key.optional(), createdAt: finite });
const manifestSchema = z.object({ schemaVersion: z.literal(4), latest: key.optional(), latestRevision: key.optional(), history: z.array(entrySchema).max(HISTORY_LIMIT) });
type Manifest = z.infer<typeof manifestSchema>;

export function extractFigmaLastModified(raw: unknown): string | undefined {
  const value = (raw as { lastModified?: unknown } | null)?.lastModified;
  return typeof value === "string" && value.trim() ? value : undefined;
}
export function hashClusterNodes(nodes: NormalizedNode[]): string {
  return hash(stableStringify(nodes.map(node => ({ id: node.id, name: node.name, type: node.type,
    text: node.text, imageRef: node.imageRef, table: node.table, contentFingerprint: node.contentFingerprint,
    pageId: node.pageId, sectionIds: node.sectionIds,
    connectorStartId: node.connectorStartId, connectorEndId: node.connectorEndId,
    connectorStartArrowhead: node.connectorStartArrowhead, connectorEndArrowhead: node.connectorEndArrowhead,
    rotation: node.rotation,
  })).sort((a, b) => a.id.localeCompare(b.id))));
}
export function hashNormalizedNodes(nodes: NormalizedNode[]): string {
  return hash(stableStringify([...nodes].sort((a, b) => a.id.localeCompare(b.id))));
}
export function buildSnapshotId(fileKey: string, nodeHash: string): string {
  return hash(JSON.stringify([fileKey, EXTRACTION_VERSION, nodeHash]));
}
export function getRefinementSignature(): string {
  return hash(JSON.stringify([getModelConfigSignature(), process.env.LLM_BASE_URL ?? "", EXTRACTION_VERSION, PROMPT_VERSION]));
}
export function buildBoardCacheKey(identity: BoardCacheIdentity): string {
  return hash(JSON.stringify({ ...identity, figmaLastModified: undefined, schemaVersion: CACHE_SCHEMA_VERSION,
    customPhases: identity.customPhases ?? [], refinementSignature: getRefinementSignature() }));
}

/** Sources are immutable and stored separately from provider-dependent refinements. */
async function writeBoardLocked(cacheKey: string, revisionId: string, board: BoardData, signal?: AbortSignal): Promise<BoardData> {
  key.parse(cacheKey);
  const nodeHash = board.nodeHash ?? hashNormalizedNodes(board.nodes);
  const snapshotId = buildSnapshotId(board.fileKey, nodeHash);
  const normalized = boardSchema.parse({ ...board, schemaVersion: 4, snapshotId, nodeHash, cacheKey }) as BoardData;
  const { nodes, connectorEdges, ...derived } = normalized;
  const sourcePath = path.join(CACHE_DIR, `source-${snapshotId}.json`);
  // Rewriting identical source bytes repairs corruption without changing source identity.
  await atomicWrite(sourcePath, { schemaVersion: 4, snapshotId, fileKey: board.fileKey, nodes, connectorEdges }, signal);
  await atomicWrite(cachePath(revisionId), { schemaVersion: 4, revisionId, snapshotId, derived }, signal);
  return normalized;
}
export async function readCachedBoard(cacheKey: string, fileKey?: string): Promise<BoardData | undefined> {
  try {
    key.parse(cacheKey);
    let revisionId = cacheKey;
    if (fileKey) {
      const manifest = await readManifest(fileKey);
      const entry = manifest?.history.findLast(item => item.cacheKey === cacheKey);
      if (!entry) return undefined;
      revisionId = entry.refinementId ?? entry.cacheKey;
    }
    const envelope = z.object({ schemaVersion: z.literal(4), revisionId: key, snapshotId: key, derived: z.record(z.string(), z.unknown()) }).parse(await readJson(cachePath(revisionId)));
    const source = z.object({ schemaVersion: z.literal(4), snapshotId: key, fileKey: key, nodes: z.array(nodeSchema).max(MAX_BOARD_NODES), connectorEdges: z.array(edgeSchema).optional() }).parse(await readJson(path.join(CACHE_DIR, `source-${envelope.snapshotId}.json`)));
    const board = boardSchema.parse({ ...envelope.derived, nodes: source.nodes, connectorEdges: source.connectorEdges }) as BoardData;
    if (envelope.revisionId !== revisionId || (fileKey && (board.fileKey !== fileKey || board.cacheKey !== cacheKey)) || board.snapshotId !== source.snapshotId || board.fileKey !== source.fileKey || board.boardId !== board.fileKey || buildSnapshotId(board.fileKey, hashNormalizedNodes(board.nodes)) !== board.snapshotId) throw new Error("Cache identity mismatch");
    return board;
  } catch (error) {
    if (!isMissing(error)) console.error("Persistent cache entry is invalid; run ingest_board to rebuild it.");
    return undefined;
  }
}
export async function readLatestBoard(fileKey: string): Promise<BoardData | undefined> {
  const manifest = await readManifest(fileKey);
  if (!manifest?.latest) return undefined;
  const board = await readCachedBoard(manifest.latestRevision ?? manifest.latest);
  return board?.fileKey === fileKey ? board : undefined;
}
export async function readBoardSnapshot(fileKey: string, snapshotId: string): Promise<BoardData | undefined> {
  key.parse(snapshotId);
  const manifest = await readManifest(fileKey);
  const entry = manifest?.history.findLast(item => item.snapshotId === snapshotId);
  if (!entry) return undefined;
  const board = await readCachedBoard(entry.refinementId ?? entry.cacheKey);
  return board?.fileKey === fileKey && board.snapshotId === snapshotId ? board : undefined;
}
export async function hasLegacyBoard(fileKey: string): Promise<boolean> {
  key.parse(fileKey);
  try { await stat(path.join(LEGACY_ROOT, `latest-${fileKey}.json`)); return true; } catch { return false; }
}
export async function readBoardHistory(fileKey: string): Promise<BoardHistoryEntry[]> {
  return (await readManifest(fileKey))?.history ?? [];
}
/** One manifest rename publishes sources, refinement, latest pointer and history together. */
export async function persistBoard(board: BoardData, signal?: AbortSignal): Promise<void> {
  if (!board.cacheKey) throw new Error("Cannot persist board without cacheKey");
  await withMutation(async () => {
    await garbageCollect().catch(() => console.error("Snapshot cleanup deferred; committed snapshots are intact."));
    signal?.throwIfAborted();
    const revisionId = hash(randomUUID());
    const normalized = await writeBoardLocked(board.cacheKey!, revisionId, board, signal);
    const manifest = await readManifest(board.fileKey) ?? emptyManifest();
    manifest.latest = board.cacheKey;
    manifest.latestRevision = revisionId;
    updateHistory(manifest, { cacheKey: board.cacheKey!, refinementId: revisionId, snapshotId: normalized.snapshotId, nodeHash: normalized.nodeHash!, createdAt: board.createdAt });
    signal?.throwIfAborted();
    await atomicWrite(manifestPath(board.fileKey), manifest, signal);
  }, signal);
}
function updateHistory(manifest: Manifest, entry: BoardHistoryEntry): void {
  const last = manifest.history.at(-1);
  if (last && (last.nodeHash === entry.nodeHash || last.cacheKey === entry.cacheKey)) {
    manifest.history[manifest.history.length - 1] = { ...entry, createdAt: last.createdAt };
  } else manifest.history.push(entry);
  manifest.history = manifest.history.slice(-HISTORY_LIMIT);
}
function emptyManifest(): Manifest { return { schemaVersion: 4, history: [] }; }
async function readManifest(fileKey: string): Promise<Manifest | undefined> {
  try { return manifestSchema.parse(await readJson(manifestPath(fileKey))); } catch (error) {
    if (!isMissing(error)) console.error("Board cache manifest is invalid; run ingest_board to rebuild it.");
    return undefined;
  }
}
async function garbageCollect(): Promise<void> {
  const names = await readdir(CACHE_DIR);
  const refinements = new Set<string>();
  const sources = new Set<string>();
  // Fail closed if any manifest is damaged. Legacy v3 files are outside v4 and never touched.
  try {
    for (const name of names.filter(name => name.startsWith("board-") && name.endsWith(".json"))) {
      const manifest = manifestSchema.parse(await readJson(path.join(CACHE_DIR, name)));
      if (manifest.latest) refinements.add(manifest.latestRevision ?? manifest.latest);
      for (const entry of manifest.history) refinements.add(entry.refinementId ?? entry.cacheKey);
    }
    for (const ref of refinements) {
      const envelope = z.object({ schemaVersion: z.literal(4), snapshotId: key }).parse(await readJson(cachePath(ref)));
      sources.add(envelope.snapshotId);
    }
  } catch { console.error("Snapshot cleanup skipped: a cache reference is invalid."); return; }
  // Only collect our versioned artifacts; preserve recent unpublished writes from compatibility callers.
  for (const name of names) {
    const sourceId = /^source-([a-f0-9]{64})\.json$/.exec(name)?.[1];
    const refinementId = /^refinement-([A-Za-z0-9_-]{1,128})\.json$/.exec(name)?.[1];
    if ((!sourceId || sources.has(sourceId)) && (!refinementId || refinements.has(refinementId))) continue;
    const filename = path.join(CACHE_DIR, name);
    // A short grace period protects readers that captured the previous manifest before a publish.
    if (Date.now() - (await stat(filename)).mtimeMs < 60_000) continue;
    await unlink(filename);
  }
}
async function privateDirectory(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  await chmod(CACHE_DIR, 0o700);
  await chmod(CACHE_ROOT, 0o700);
}
async function atomicWrite(filename: string, value: unknown, signal?: AbortSignal): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
    await file.close();
    signal?.throwIfAborted();
    await rename(temporary, filename);
  } finally {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}
async function withMutation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const result = mutationQueue.then(async () => {
    signal?.throwIfAborted();
    await privateDirectory();
    const lockPath = path.join(CACHE_DIR, ".write-lock");
    const token = randomUUID();
    const started = Date.now();
    for (;;) {
      signal?.throwIfAborted();
      try {
        await mkdir(lockPath, { mode: 0o700 });
        try { await atomicWrite(path.join(lockPath, "owner.json"), { pid: process.pid, token }); }
        catch (error) { await rm(lockPath, { recursive: true, force: true }); throw error; }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Fail closed: deleting a seemingly stale lock races with another process
        // acquiring it. Recovery requires stopping all servers before removing it.
        if (Date.now() - started >= 10_000) throw new Error("Cache is busy in another process. Retry ingest_board. If a writer crashed, stop all servers before removing v4/.write-lock from the cache directory.");
        await delay(20, undefined, { signal });
      }
    }
    try { return await operation(); } finally {
      try {
        const owner = await readJson(path.join(lockPath, "owner.json")) as { token?: unknown };
        if (owner.token === token) await rm(lockPath, { recursive: true, force: true });
      } catch { console.error("Cache lock cleanup failed; stop all servers before removing v4/.write-lock."); }
    }
  });
  mutationQueue = result.catch(() => undefined);
  return result;
}
function manifestPath(fileKey: string): string { key.parse(fileKey); return path.join(CACHE_DIR, `board-${fileKey}.json`); }
function cachePath(cacheKey: string): string { key.parse(cacheKey); return path.join(CACHE_DIR, `refinement-${cacheKey}.json`); }
async function readJson(filename: string): Promise<unknown> {
  const size = (await stat(filename)).size;
  if (size > 128 * 1024 * 1024) throw new Error("Cache file exceeds 128 MiB");
  return JSON.parse(await readFile(filename, "utf8"));
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
