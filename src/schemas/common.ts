import { z } from "zod";

/** Figma file keys are opaque, case-sensitive, ASCII-alphanumeric identifiers. */
export const FIGMA_FILE_KEY_MIN_LENGTH = 6;
export const FIGMA_FILE_KEY_MAX_LENGTH = 128;

const FIGMA_FILE_KEY_PATTERN = /^[A-Za-z0-9]+$/;
const FIGMA_BRANCH_PATH_PATTERN = /^\/(?:file|design|board)\/([A-Za-z0-9]+)\/branch\/([A-Za-z0-9]+)(?:\/[^/]+)?\/?$/;
const FIGMA_FILE_PATH_PATTERN =
  /^\/(?:file|design|board|proto)\/([A-Za-z0-9]+)(?:\/[^/]+)?\/?$/;

export const figmaFileKeySchema = z
  .string()
  .trim()
  .min(FIGMA_FILE_KEY_MIN_LENGTH, "boardId is too short to be a Figma file key")
  .max(FIGMA_FILE_KEY_MAX_LENGTH, "boardId is too long to be a Figma file key")
  .regex(FIGMA_FILE_KEY_PATTERN, "boardId must be an ASCII-alphanumeric Figma file key");

/** A Figma file key and, when the URL names one, the raw value of its node-id parameter (e.g. "5-87"). */
export interface FigmaUrlReference {
  fileKey: string;
  nodeId?: string;
}

/**
 * Parses canonical HTTPS Figma file URLs only. URL parsing is intentionally
 * shared with ingest_board so schema validation and execution cannot disagree
 * about which host/path is trusted.
 */
export function parseFigmaUrl(value: string): FigmaUrlReference | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }

  const authority = /^https:\/\/([^/?#]*)/i.exec(value.trim())?.[1];
  const hostname = url.hostname.toLowerCase();
  const isFigmaHost = hostname === "figma.com" || hostname.endsWith(".figma.com");
  if (
    url.protocol !== "https:" ||
    !isFigmaHost ||
    authority?.includes("@") ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return undefined;
  }

  const branch = FIGMA_BRANCH_PATH_PATTERN.exec(url.pathname);
  const match = FIGMA_FILE_PATH_PATTERN.exec(url.pathname);
  if (branch && !figmaFileKeySchema.safeParse(branch[1]).success) return undefined;
  const key = branch?.[2] ?? match?.[1];
  if (!key) {
    return undefined;
  }

  const parsedKey = figmaFileKeySchema.safeParse(key);
  if (!parsedKey.success) return undefined;
  const nodeId = url.searchParams.get("node-id")?.trim();
  return { fileKey: parsedKey.data, ...(nodeId ? { nodeId } : {}) };
}

/** Notices are shown only for trusted, validated URLs. */
export function figmaUrlNotices(value: string): string[] {
  if (!parseFigmaUrl(value)) return [];
  const pathname = new URL(value.trim()).pathname;
  const notices: string[] = [];
  if (FIGMA_BRANCH_PATH_PATTERN.test(pathname)) notices.push("The branch key is used as the file key.");
  if (/^\/(?:design|file|proto)\//.test(pathname)) notices.push("Clustering and reading order are designed for FigJam boards.");
  return notices;
}

/** Returns the key only for canonical HTTPS Figma file URLs. */
export function extractFigmaFileKeyFromUrl(value: string): string | undefined {
  return parseFigmaUrl(value)?.fileKey;
}

/** An example instead of a pattern: new users copy the URL from the browser. */
export const FIGMA_URL_HINT =
  "Expected a Figma URL like https://www.figma.com/board/<file_key>/<name> (/board/, /design/, /file/ or /proto/)";

export const figmaFileUrlSchema = z
  .string()
  .trim()
  .max(2048, "Figma URL is too long")
  .url({ message: FIGMA_URL_HINT, abort: true })
  .refine((value) => extractFigmaFileKeyFromUrl(value) !== undefined, FIGMA_URL_HINT);

export const questionSchema = z
  .string()
  .trim()
  .min(1, "question must not be empty")
  .max(2000, "question must be at most 2000 characters")
  .describe("One specific question using the board's words and language (1–2000 characters after trimming)");

export const topicSchema = z
  .string()
  .trim()
  .min(1, "topic must not be empty")
  .max(200, "topic must be at most 200 characters");

export const BOARD_ID_MAX_LENGTH = 2048;
const BOARD_ID_HINT =
  "boardId must be an ASCII-alphanumeric Figma file key (the <key> in figma.com/board/<key>/…) or a Figma URL. " +
  FIGMA_URL_HINT;

/**
 * The boardId of get_board_context, answer_from_board and diff_board: the file
 * key, or the board URL as copied from the browser.
 */
export function parseBoardId(value: string): FigmaUrlReference | undefined {
  const trimmed = value.trim();
  const key = figmaFileKeySchema.safeParse(trimmed);
  return key.success ? { fileKey: key.data } : parseFigmaUrl(trimmed);
}

export const boardIdInputSchema = z
  .string()
  .trim()
  .min(FIGMA_FILE_KEY_MIN_LENGTH, { error: "boardId is too short to be a Figma file key", abort: true })
  .max(BOARD_ID_MAX_LENGTH, { error: "boardId is too long", abort: true })
  .refine((value) => parseBoardId(value) !== undefined, BOARD_ID_HINT);

/** Output field of all tools: the unknown input keys that were dropped (never their values). */
export const ignoredArgumentsShape = {
  ignoredArguments: z.array(z.string()).optional()
    .describe("Unknown input keys that were ignored; their values are not echoed. Absent when none"),
};
