import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { BoardData, DocStructureHint, IngestMode, NormalizedNode } from "../types.js";
import { getVisionConfigSignature } from "./modelRegistry.js";
import { MAX_BOARD_NODES } from "./nodeTree.js";
import { expandHomePath } from "./envFile.js";
import { compareCodeUnits } from "./stringOrder.js";
import { withCacheLock } from "./cacheLock.js";

export const CACHE_SCHEMA_VERSION = 4;
export const EXTRACTION_VERSION = 7;
export const PROMPT_VERSION = 8;
function defaultCacheRoot(): string { return process.platform === "darwin"
  ? path.join(homedir(), "Library", "Caches", "figjam-context-mcp")
  : process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "figjam-context-mcp")
    : path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "figjam-context-mcp"); }
function cacheRoot(): string { return expandHomePath(process.env.FIGJAM_MCP_CACHE_DIR ?? defaultCacheRoot()); }
function cacheDirectory(): string { return path.join(cacheRoot(), "v4"); }
function legacyRoot(): string { return expandHomePath(process.env.FIGJAM_MCP_CACHE_DIR ?? path.join(process.cwd(), ".cache", "figjam-mcp")); }
const HISTORY_LIMIT = 20;
let mutationQueue: Promise<unknown> = Promise.resolve();
const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const finite = z.number().finite();
const extractionVersionSchema = z.number().int().min(4).default(4);
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
  schemaVersion: z.literal(4), extractionVersion: extractionVersionSchema, snapshotId: key, boardId: key, fileKey: key,
  docStructureHint: z.enum(["freeform", "double_diamond", "lean_canvas", "retro", "user_journey"]),
  nodes: z.array(nodeSchema).max(MAX_BOARD_NODES), clusters: z.array(clusterSchema).max(MAX_BOARD_NODES), createdAt: finite,
  connectorEdges: z.array(edgeSchema).optional(),
  clusterRelations: z.array(z.object({ fromClusterId: z.string(), toClusterId: z.string(), labels: z.array(z.string()), edgeCount: finite })).optional(),
  customPhases: z.array(z.string()).optional(), ingestMode: z.enum(["balanced", "max_quality", "max_speed"]).optional(),
  cacheKey: key.optional(), figmaVersion: z.string().optional(), figmaLastModified: z.string().optional(),
  nodeHash: z.string().optional(), refinementSignature: z.string().optional(), freshnessCheckedAt: finite.optional(),
  qualityReport: z.object({ modelsUsed: z.array(z.string()), cachedClusters: finite, deterministicClusters: finite, visionClusters: finite, fallbackCount: finite, reusedClusters: finite.optional(), incompleteClusters: finite.optional(), fallbackReasons: z.record(z.string(), finite).optional(), nextRetryAt: finite.optional(), figmaRequests: z.object({ imageFills: finite, renders: finite }).optional(), focus: z.object({ requestedIds: z.array(z.string()), foundIds: z.array(z.string()), imageClusters: finite, interpreted: finite, pending: finite }).optional() }).optional(),
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
  })).sort((a, b) => compareCodeUnits(a.id, b.id))));
}
export function hashNormalizedNodes(nodes: NormalizedNode[]): string {
  return hashNormalizedNodesForVersion(nodes, EXTRACTION_VERSION);
}
/** Historical source identities must use the writer's ordering, including object keys. */
function hashNormalizedNodesForVersion(nodes: NormalizedNode[], extractionVersion: number): string {
  const compare = extractionVersion <= 6 ? (a: string, b: string) => a.localeCompare(b) : compareCodeUnits;
  return hash(stableStringify([...nodes].sort((a, b) => compare(a.id, b.id)), compare));
}
export function buildSnapshotId(fileKey: string, nodeHash: string, extractionVersion = EXTRACTION_VERSION): string {
  return hash(JSON.stringify([fileKey, extractionVersion, nodeHash]));
}
export function getRefinementSignature(ingestMode?: IngestMode): string {
  return hash(JSON.stringify([ingestMode === "max_speed" ? "max_speed" : getVisionConfigSignature(), process.env.LLM_BASE_URL ?? "", EXTRACTION_VERSION, PROMPT_VERSION]));
}
export function buildBoardCacheKey(identity: BoardCacheIdentity): string {
  return hash(JSON.stringify({ ...identity, figmaLastModified: undefined, schemaVersion: CACHE_SCHEMA_VERSION,
    customPhases: identity.customPhases ?? [], refinementSignature: getRefinementSignature(identity.ingestMode) }));
}

/** Sources are immutable and stored separately from provider-dependent refinements. */
async function writeBoardLocked(cacheKey: string, revisionId: string, board: BoardData, signal?: AbortSignal): Promise<BoardData> {
  key.parse(cacheKey);
  const nodeHash = hashNormalizedNodes(board.nodes);
  const snapshotId = buildSnapshotId(board.fileKey, nodeHash);
  const normalized = boardSchema.parse({ ...board, schemaVersion: 4, extractionVersion: EXTRACTION_VERSION, snapshotId, nodeHash, cacheKey }) as BoardData;
  const { nodes, connectorEdges, ...derived } = normalized;
  const sourcePath = path.join(cacheDirectory(), `source-${snapshotId}.json`);
  // Rewriting identical source bytes repairs corruption without changing source identity.
  await atomicWrite(sourcePath, { schemaVersion: 4, extractionVersion: EXTRACTION_VERSION, snapshotId, fileKey: board.fileKey, nodes, connectorEdges }, signal);
  await atomicWrite(cachePath(revisionId), { schemaVersion: 4, revisionId, snapshotId, derived }, signal);
  return normalized;
}
export interface CachedBoardState { board?: BoardData; damaged: boolean }
export interface BoardHead { revisionId?: string; createdAt?: number; snapshotId?: string; cacheKey?: string; damaged: boolean }
export interface LatestBoardState extends CachedBoardState { revisionId?: string; warning?: string }
export async function readCachedBoard(cacheKey: string, fileKey?: string): Promise<BoardData | undefined> {
  return (await readCachedBoardState(cacheKey, fileKey)).board;
}
export async function readCachedBoardState(cacheKey: string, fileKey?: string): Promise<CachedBoardState> {
  try {
    key.parse(cacheKey);
    let revisionId = cacheKey;
    if (fileKey) {
      const manifest = await readManifest(fileKey);
      const entry = manifest?.history.findLast(item => item.cacheKey === cacheKey);
      if (!entry) return { damaged: false };
      revisionId = entry.refinementId ?? entry.cacheKey;
    }
    const envelope = z.object({ schemaVersion: z.literal(4), revisionId: key, snapshotId: key, derived: z.record(z.string(), z.unknown()) }).parse(await readJson(cachePath(revisionId)));
    const source = z.object({ schemaVersion: z.literal(4), extractionVersion: extractionVersionSchema, snapshotId: key, fileKey: key, nodes: z.array(nodeSchema).max(MAX_BOARD_NODES), connectorEdges: z.array(edgeSchema).optional() }).parse(await readJson(path.join(cacheDirectory(), `source-${envelope.snapshotId}.json`)));
    const board = boardSchema.parse({ ...envelope.derived, nodes: source.nodes, connectorEdges: source.connectorEdges }) as BoardData;
    if (envelope.revisionId !== revisionId || (fileKey && (board.fileKey !== fileKey || board.cacheKey !== cacheKey)) || board.snapshotId !== envelope.snapshotId || board.snapshotId !== source.snapshotId || board.extractionVersion !== source.extractionVersion || board.fileKey !== source.fileKey || board.boardId !== board.fileKey || buildSnapshotId(board.fileKey, hashNormalizedNodesForVersion(board.nodes, board.extractionVersion ?? 4), board.extractionVersion) !== board.snapshotId) throw new Error("Cache identity mismatch");
    return { board, damaged: false };
  } catch (error) {
    if (!isMissing(error)) console.error("Persistent cache entry is invalid; run ingest_board to rebuild it.");
    return { damaged: !isMissing(error) };
  }
}
export async function readBoardHead(fileKey: string): Promise<BoardHead> {
  const { manifest, damaged } = await readManifestState(fileKey);
  const entry = manifest?.history.at(-1);
  return { damaged, revisionId: manifest?.latestRevision ?? manifest?.latest,
    createdAt: entry?.createdAt, snapshotId: entry?.snapshotId, cacheKey: entry?.cacheKey };
}
export async function readLatestBoard(fileKey: string): Promise<BoardData | undefined> {
  return (await readLatestBoardState(fileKey)).board;
}
export async function readLatestBoardState(fileKey: string): Promise<LatestBoardState> {
  const { manifest, damaged } = await readManifestState(fileKey);
  if (!manifest?.latest) return { damaged };
  const revisionId = manifest.latestRevision ?? manifest.latest;
  const revisions = [...new Set([revisionId, ...manifest.history.toReversed().map(entry => entry.refinementId ?? entry.cacheKey)])];
  for (const [index, revision] of revisions.entries()) {
    const { board } = await readCachedBoardState(revision);
    if (!board || board.fileKey !== fileKey) continue;
    const warning = index > 0
      ? `The latest cached snapshot cannot be read (damaged files); using the snapshot from ${new Date(board.createdAt).toISOString()}; run ingest_board to rebuild.`
      : undefined;
    return { board, revisionId, damaged: index > 0, ...(warning ? { warning } : {}) };
  }
  return { revisionId, damaged: true };
}
export async function readBoardSnapshot(fileKey: string, snapshotId: string): Promise<BoardData | undefined> {
  return (await readBoardSnapshotState(fileKey, snapshotId)).board;
}
export async function readBoardSnapshotState(fileKey: string, snapshotId: string): Promise<LatestBoardState> {
  key.parse(snapshotId);
  const { manifest, damaged } = await readManifestState(fileKey);
  const entry = manifest?.history.findLast(item => item.snapshotId === snapshotId);
  if (!entry) return { damaged };
  const revisionId = entry.refinementId ?? entry.cacheKey;
  const state = await readCachedBoardState(revisionId);
  if (state.board && (state.board.fileKey !== fileKey || state.board.snapshotId !== snapshotId)) return { revisionId, damaged: true };
  return { ...state, revisionId };
}
export async function hasLegacyBoard(fileKey: string): Promise<boolean> {
  key.parse(fileKey);
  try { await stat(path.join(legacyRoot(), `latest-${fileKey}.json`)); return true; } catch { return false; }
}
/** File keys with a board manifest, in the case they were stored; names only, so a lookup stays cheap. */
export async function listStoredFileKeys(): Promise<string[]> {
  let names: string[];
  try { names = await readdir(cacheDirectory()); } catch { return []; }
  return names.flatMap(name => /^board-([A-Za-z0-9_-]{1,128})\.json$/.exec(name)?.[1] ?? []);
}
export interface StoredBoard { fileKey: string; lastIngestAt: number }
/** The boards in the cache, most recently ingested first; only file keys and times. */
export async function listStoredBoards(): Promise<StoredBoard[]> {
  const boards: StoredBoard[] = [];
  for (const fileKey of await listStoredFileKeys()) {
    const last = (await readManifest(fileKey))?.history.at(-1);
    if (last) boards.push({ fileKey, lastIngestAt: last.createdAt });
  }
  return boards.sort((a, b) => b.lastIngestAt - a.lastIngestAt || compareCodeUnits(a.fileKey, b.fileKey));
}
export async function readBoardHistory(fileKey: string): Promise<BoardHistoryEntry[]> {
  return (await readManifest(fileKey))?.history ?? [];
}
/** One manifest rename publishes sources, refinement, latest pointer and history together. */
export async function persistBoard(board: BoardData, signal?: AbortSignal): Promise<{ historyReset: boolean; revisionId: string }> {
  if (!board.cacheKey) throw new Error("Cannot persist board without cacheKey");
  return withMutation(async () => {
    await garbageCollect().catch(() => console.error("Snapshot cleanup deferred; committed snapshots are intact."));
    signal?.throwIfAborted();
    const revisionId = hash(randomUUID());
    const normalized = await writeBoardLocked(board.cacheKey!, revisionId, board, signal);
    const state = await readManifestState(board.fileKey);
    const manifest = state.manifest ?? emptyManifest();
    manifest.latest = board.cacheKey;
    manifest.latestRevision = revisionId;
    updateHistory(manifest, { cacheKey: board.cacheKey!, refinementId: revisionId, snapshotId: normalized.snapshotId, nodeHash: normalized.nodeHash!, createdAt: board.createdAt });
    signal?.throwIfAborted();
    await atomicWrite(manifestPath(board.fileKey), manifest, signal);
    return { historyReset: state.damaged, revisionId };
  }, signal);
}
function updateHistory(manifest: Manifest, entry: BoardHistoryEntry): void {
  const last = manifest.history.at(-1);
  if (last && last.snapshotId === entry.snapshotId && (last.nodeHash === entry.nodeHash || last.cacheKey === entry.cacheKey)) {
    manifest.history[manifest.history.length - 1] = { ...entry, createdAt: last.createdAt };
  } else manifest.history.push(entry);
  manifest.history = manifest.history.slice(-HISTORY_LIMIT);
}
function emptyManifest(): Manifest { return { schemaVersion: 4, history: [] }; }
async function readManifest(fileKey: string): Promise<Manifest | undefined> {
  return (await readManifestState(fileKey)).manifest;
}
async function readManifestState(fileKey: string): Promise<{ manifest?: Manifest; damaged: boolean }> {
  try { return { manifest: manifestSchema.parse(await readJson(manifestPath(fileKey))), damaged: false }; } catch (error) {
    if (!isMissing(error)) console.error("Board cache manifest is invalid; run ingest_board to rebuild it.");
    return { damaged: !isMissing(error) };
  }
}
async function garbageCollect(): Promise<void> {
  const names = await readdir(cacheDirectory());
  const refinements = new Set<string>();
  const sources = new Set<string>();
  const damagedBoards = new Set<string>();
  for (const name of names.filter(name => name.startsWith("board-") && name.endsWith(".json"))) {
    try {
      const manifest = manifestSchema.parse(await readJson(path.join(cacheDirectory(), name)));
      if (manifest.latest) refinements.add(manifest.latestRevision ?? manifest.latest);
      for (const entry of manifest.history) {
        refinements.add(entry.refinementId ?? entry.cacheKey);
        if (entry.snapshotId) sources.add(entry.snapshotId);
      }
    } catch {
      // Keep artifacts belonging to this board when its references cannot be read.
      damagedBoards.add(name.slice("board-".length, -".json".length));
    }
  }
  for (const ref of refinements) {
    try {
      const envelope = z.object({ schemaVersion: z.literal(4), snapshotId: key }).parse(await readJson(cachePath(ref)));
      sources.add(envelope.snapshotId);
    } catch { /* A damaged entry must not stop cleanup for other boards. */ }
  }
  for (const name of names) {
    const filename = path.join(cacheDirectory(), name);
    if (name.endsWith(".tmp")) {
      if (Date.now() - (await stat(filename)).mtimeMs > 3_600_000) await unlink(filename);
      continue;
    }
    const sourceId = /^source-([a-f0-9]{64})\.json$/.exec(name)?.[1];
    const refinementId = /^refinement-([A-Za-z0-9_-]{1,128})\.json$/.exec(name)?.[1];
    if ((!sourceId || sources.has(sourceId)) && (!refinementId || refinements.has(refinementId))) continue;
    // A short grace period protects readers that captured the previous manifest before a publish.
    if (Date.now() - (await stat(filename)).mtimeMs < 60_000) continue;
    if (damagedBoards.size > 0) {
      try {
        const artifact = await readJson(filename) as { fileKey?: string; derived?: { fileKey?: string } };
        if (damagedBoards.has(artifact.fileKey ?? artifact.derived?.fileKey ?? "")) continue;
      } catch { continue; }
    }
    await unlink(filename);
  }
}
async function privateDirectory(): Promise<void> {
  // mkdir reports whether this server created the directory; user-owned modes stay intact.
  if (await mkdir(cacheRoot(), { recursive: true, mode: 0o700 })) await chmod(cacheRoot(), 0o700);
  if (await mkdir(cacheDirectory(), { recursive: true, mode: 0o700 })) await chmod(cacheDirectory(), 0o700);
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
    return withCacheLock(cacheDirectory(), operation, signal);
  });
  mutationQueue = result.catch(() => undefined);
  return result;
}
function manifestPath(fileKey: string): string { key.parse(fileKey); return path.join(cacheDirectory(), `board-${fileKey}.json`); }
function cachePath(cacheKey: string): string { key.parse(cacheKey); return path.join(cacheDirectory(), `refinement-${cacheKey}.json`); }
async function readJson(filename: string): Promise<unknown> {
  const size = (await stat(filename)).size;
  if (size > 128 * 1024 * 1024) throw new Error("Cache file exceeds 128 MiB");
  return JSON.parse(await readFile(filename, "utf8"));
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function stableStringify(value: unknown, compare = compareCodeUnits): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b))) : item);
}
