import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BoardData, DocStructureHint, IngestMode, NormalizedNode } from "../types.js";
import { getModelConfigSignature } from "./modelRegistry.js";

const CACHE_DIR = process.env.FIGJAM_MCP_CACHE_DIR ?? path.join(process.cwd(), ".cache", "figjam-mcp");

/**
 * Bumped whenever the persisted BoardData shape or the node hash inputs
 * change incompatibly, so stale entries miss cleanly instead of loading
 * with missing fields. v2: connector edges + cluster relations + phases.
 * v3: bounded spatial clusters and prompt-safe refinement semantics.
 */
const CACHE_SCHEMA_VERSION = 3;

/**
 * Serializes every in-process mutation of cache reference metadata. History
 * retention scans all boards' history/latest files before deleting a snapshot,
 * so a per-board lock would still allow another board to add a reference in
 * the scan-to-unlink window.
 */
let referenceMutationQueue: Promise<void> = Promise.resolve();

export interface BoardCacheIdentity {
  fileKey: string;
  figmaLastModified?: string;
  nodeHash: string;
  docStructureHint: DocStructureHint;
  customPhases?: string[];
  ingestMode: IngestMode;
}

export function extractFigmaLastModified(rawFigmaJson: unknown): string | undefined {
  const value = (rawFigmaJson as { lastModified?: unknown } | null)?.lastModified;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Content hash of one cluster's member nodes, used to decide whether a
 * previous refinement (label/summary) is still valid. Position, size, and
 * rotation are deliberately excluded: moving a group around the canvas does
 * not change what it says, so its summary stays reusable. Node ids ARE
 * included — membership changes must produce a different hash.
 */
export function hashClusterNodes(nodes: NormalizedNode[]): string {
  const stable = nodes
    .map((node) => ({
      id: node.id,
      type: node.type,
      text: node.text?.trim() || undefined,
      imageRef: node.imageRef,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return hash(JSON.stringify(stable));
}

export function hashNormalizedNodes(nodes: NormalizedNode[]): string {
  const stable = nodes
    .map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rotation: node.rotation,
      imageRef: node.imageRef,
      text: node.text,
      parentId: node.parentId,
      connectorStartId: node.connectorStartId,
      connectorEndId: node.connectorEndId,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return hash(JSON.stringify(stable));
}

export function buildBoardCacheKey(identity: BoardCacheIdentity): string {
  return hash(
    JSON.stringify({
      ...identity,
      schemaVersion: CACHE_SCHEMA_VERSION,
      figmaLastModified: identity.figmaLastModified ?? "unknown",
      customPhases: identity.customPhases ?? [],
      modelConfig: getModelConfigSignature(),
    }),
  );
}

export async function readCachedBoard(cacheKey: string): Promise<BoardData | undefined> {
  try {
    const raw = await readFile(cachePath(cacheKey), "utf8");
    return JSON.parse(raw) as BoardData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    console.error(`Persistent cache read failed for ${cacheKey}: ${errorMessage(error)}`);
    return undefined;
  }
}

export async function writeCachedBoard(cacheKey: string, board: BoardData): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath(cacheKey), `${JSON.stringify(board)}\n`, "utf8");
  } catch (error) {
    console.error(`Persistent cache write failed for ${cacheKey}: ${errorMessage(error)}`);
  }
}

/**
 * Records which cache entry is the most recent ingest for a file, so tools
 * can restore a board after a server restart without re-ingesting.
 * (Entries themselves are keyed by content/config hash — the pointer is the
 * only way back from a bare fileKey.)
 */
export async function writeLatestBoardPointer(fileKey: string, cacheKey: string): Promise<void> {
  await serializeReferenceMutation(async () => {
    try {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(
        latestPointerPath(fileKey),
        `${JSON.stringify({ cacheKey, schemaVersion: CACHE_SCHEMA_VERSION })}\n`,
        "utf8",
      );
    } catch (error) {
      console.error(`Latest-board pointer write failed for ${fileKey}: ${errorMessage(error)}`);
    }
  });
}

/** Loads the most recently ingested BoardData for a file, if persisted. */
export async function readLatestBoard(fileKey: string): Promise<BoardData | undefined> {
  try {
    const raw = await readFile(latestPointerPath(fileKey), "utf8");
    const pointer = JSON.parse(raw) as { cacheKey?: unknown; schemaVersion?: unknown };
    if (
      pointer.schemaVersion !== CACHE_SCHEMA_VERSION ||
      typeof pointer.cacheKey !== "string" ||
      !pointer.cacheKey
    ) {
      return undefined;
    }
    return await readCachedBoard(pointer.cacheKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Latest-board pointer read failed for ${fileKey}: ${errorMessage(error)}`);
    }
    return undefined;
  }
}

/** One entry in a board's ingest history (newest last). */
export interface BoardHistoryEntry {
  cacheKey: string;
  nodeHash: string;
  createdAt: number;
}

/** Max snapshots remembered per board; older entries are dropped. */
const HISTORY_LIMIT = 20;

/**
 * Appends a snapshot to the board's ingest history so diff_board can compare
 * board states over time. Re-ingests of an unchanged board (same cacheKey as
 * the newest entry) are skipped — the history only records distinct states.
 */
export async function writeBoardHistoryEntry(
  fileKey: string,
  entry: BoardHistoryEntry,
): Promise<void> {
  await serializeReferenceMutation(() => writeBoardHistoryEntryLocked(fileKey, entry));
}

async function writeBoardHistoryEntryLocked(
  fileKey: string,
  entry: BoardHistoryEntry,
): Promise<void> {
  let droppedCacheKeys: string[] = [];
  let retainedCacheKeys = new Set<string>();

  try {
    const history = await readBoardHistory(fileKey);
    if (history.at(-1)?.cacheKey === entry.cacheKey) {
      return;
    }
    history.push(entry);
    const capped = history.slice(-HISTORY_LIMIT);
    retainedCacheKeys = new Set(capped.map((historyEntry) => historyEntry.cacheKey));
    droppedCacheKeys = [
      ...new Set(
        history
          .slice(0, -HISTORY_LIMIT)
          .map((historyEntry) => historyEntry.cacheKey)
          .filter((cacheKey) => !retainedCacheKeys.has(cacheKey)),
      ),
    ];
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(historyPath(fileKey), `${JSON.stringify(capped)}\n`, "utf8");
  } catch (error) {
    console.error(`Board history write failed for ${fileKey}: ${errorMessage(error)}`);
    return;
  }

  if (droppedCacheKeys.length > 0) {
    await garbageCollectSnapshots(fileKey, droppedCacheKeys, retainedCacheKeys);
  }
}

/** Reads a board's ingest history (oldest first, [] when none exists). */
export async function readBoardHistory(fileKey: string): Promise<BoardHistoryEntry[]> {
  try {
    const raw = await readFile(historyPath(fileKey), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is BoardHistoryEntry =>
            typeof entry?.cacheKey === "string" &&
            typeof entry?.nodeHash === "string" &&
            typeof entry?.createdAt === "number",
        )
      : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Board history read failed for ${fileKey}: ${errorMessage(error)}`);
    }
    return [];
  }
}

function historyPath(fileKey: string): string {
  return path.join(CACHE_DIR, `history-${fileKey.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function latestPointerPath(fileKey: string): string {
  // File keys are alphanumeric (enforced by parseFigmaFileKey), but sanitize
  // defensively — this value ends up in a filename.
  return path.join(CACHE_DIR, `latest-${fileKey.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function cachePath(cacheKey: string): string {
  return path.join(CACHE_DIR, `${cacheKey}.json`);
}

/**
 * Deletes only snapshots dropped from this board's capped history. Reference
 * metadata is checked globally because cache keys can be shared or manually
 * restored, and the snapshot's own fileKey is checked before unlinking so a
 * damaged history file cannot delete another board's data.
 */
async function garbageCollectSnapshots(
  fileKey: string,
  droppedCacheKeys: string[],
  retainedCacheKeys: ReadonlySet<string>,
): Promise<void> {
  for (const cacheKey of droppedCacheKeys) {
    if (retainedCacheKeys.has(cacheKey) || !isSafeCacheKey(cacheKey)) {
      continue;
    }

    const snapshotFile = cachePath(cacheKey);
    try {
      const raw = await readFile(snapshotFile, "utf8");
      const snapshot = JSON.parse(raw) as { fileKey?: unknown };
      if (snapshot.fileKey !== fileKey) {
        continue;
      }

      // Re-scan directly before unlink. All reference writers in this module
      // share referenceMutationQueue, closing the in-process scan-to-delete
      // race while still failing closed on malformed/external metadata.
      const referencedCacheKeys = await readAllSnapshotReferences(fileKey);
      if (!referencedCacheKeys || referencedCacheKeys.has(cacheKey)) {
        continue;
      }
      await unlink(snapshotFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          `Snapshot cleanup failed for board ${fileKey}, cache ${cacheKey}: ${errorMessage(error)}`,
        );
      }
    }
  }
}

/**
 * Returns every cache key referenced by a history or latest pointer. If any
 * reference file cannot be interpreted, fail closed and leave snapshots in
 * place rather than risking deletion of live data.
 */
async function readAllSnapshotReferences(fileKey: string): Promise<Set<string> | undefined> {
  let names: string[];
  try {
    names = await readdir(CACHE_DIR);
  } catch (error) {
    console.error(`Snapshot cleanup skipped for board ${fileKey}: ${errorMessage(error)}`);
    return undefined;
  }

  const referenceNames = names.filter(
    (name) =>
      (name.startsWith("history-") || name.startsWith("latest-")) && name.endsWith(".json"),
  );
  const references = new Set<string>();

  for (const name of referenceNames) {
    try {
      const parsed = JSON.parse(await readFile(path.join(CACHE_DIR, name), "utf8")) as unknown;
      if (name.startsWith("latest-")) {
        const pointer = parsed as {
          cacheKey?: unknown;
          schemaVersion?: unknown;
        } | null;
        if (pointer?.schemaVersion === undefined) {
          // Latest pointers written before schema binding are intentionally
          // stale and no longer protect a snapshot from retention cleanup.
          continue;
        }
        if (pointer.schemaVersion !== CACHE_SCHEMA_VERSION) {
          if (typeof pointer.schemaVersion === "number") {
            continue;
          }
          throw new Error("latest pointer has an invalid schemaVersion");
        }
        const cacheKey = pointer.cacheKey;
        if (typeof cacheKey !== "string" || !cacheKey) {
          throw new Error("latest pointer has no cacheKey");
        }
        references.add(cacheKey);
        continue;
      }

      if (!Array.isArray(parsed)) {
        throw new Error("history is not an array");
      }
      for (const historyEntry of parsed) {
        const cacheKey = (historyEntry as { cacheKey?: unknown } | null)?.cacheKey;
        if (typeof cacheKey !== "string" || !cacheKey) {
          throw new Error("history contains an entry without a cacheKey");
        }
        references.add(cacheKey);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      console.error(
        `Snapshot cleanup skipped for board ${fileKey}; could not read ${name}: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  return references;
}

function isSafeCacheKey(cacheKey: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(cacheKey);
}

function serializeReferenceMutation(operation: () => Promise<void>): Promise<void> {
  const result = referenceMutationQueue.then(operation);
  referenceMutationQueue = result.catch(() => undefined);
  return result;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
