import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BoardData, DocStructureHint, IngestMode, NormalizedNode } from "../types.js";
import { getModelConfigSignature } from "./modelRegistry.js";

const CACHE_DIR = process.env.FIGJAM_MCP_CACHE_DIR ?? path.join(process.cwd(), ".cache", "figjam-mcp");

/**
 * Bumped whenever the persisted BoardData shape or the node hash inputs
 * change incompatibly, so stale entries miss cleanly instead of loading
 * with missing fields. v2: connector edges + cluster relations + phases.
 */
const CACHE_SCHEMA_VERSION = 2;

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
    await writeFile(cachePath(cacheKey), `${JSON.stringify(board, null, 2)}\n`, "utf8");
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
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(latestPointerPath(fileKey), `${JSON.stringify({ cacheKey })}\n`, "utf8");
  } catch (error) {
    console.error(`Latest-board pointer write failed for ${fileKey}: ${errorMessage(error)}`);
  }
}

/** Loads the most recently ingested BoardData for a file, if persisted. */
export async function readLatestBoard(fileKey: string): Promise<BoardData | undefined> {
  try {
    const raw = await readFile(latestPointerPath(fileKey), "utf8");
    const pointer = JSON.parse(raw) as { cacheKey?: unknown };
    if (typeof pointer.cacheKey !== "string" || !pointer.cacheKey) {
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

function latestPointerPath(fileKey: string): string {
  // File keys are alphanumeric (enforced by parseFigmaFileKey), but sanitize
  // defensively — this value ends up in a filename.
  return path.join(CACHE_DIR, `latest-${fileKey.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function cachePath(cacheKey: string): string {
  return path.join(CACHE_DIR, `${cacheKey}.json`);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
