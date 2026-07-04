import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BoardData, DocStructureHint, IngestMode, NormalizedNode } from "../types.js";
import { getModelConfigSignature } from "./modelRegistry.js";

const CACHE_DIR = process.env.FIGJAM_MCP_CACHE_DIR ?? path.join(process.cwd(), ".cache", "figjam-mcp");

export interface BoardCacheIdentity {
  fileKey: string;
  figmaLastModified?: string;
  nodeHash: string;
  docStructureHint: DocStructureHint;
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
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return hash(JSON.stringify(stable));
}

export function buildBoardCacheKey(identity: BoardCacheIdentity): string {
  return hash(
    JSON.stringify({
      ...identity,
      figmaLastModified: identity.figmaLastModified ?? "unknown",
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

function cachePath(cacheKey: string): string {
  return path.join(CACHE_DIR, `${cacheKey}.json`);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
