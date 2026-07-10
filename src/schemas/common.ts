import { z } from "zod";

/** Figma file keys are opaque, case-sensitive, ASCII-alphanumeric identifiers. */
export const FIGMA_FILE_KEY_MIN_LENGTH = 6;
export const FIGMA_FILE_KEY_MAX_LENGTH = 128;

const FIGMA_FILE_KEY_PATTERN = /^[A-Za-z0-9]+$/;
const FIGMA_FILE_PATH_PATTERN =
  /^\/(?:file|design|board|proto)\/([A-Za-z0-9]+)(?:\/[^/]+)?\/?$/;

export const figmaFileKeySchema = z
  .string()
  .trim()
  .min(FIGMA_FILE_KEY_MIN_LENGTH, "boardId is too short to be a Figma file key")
  .max(FIGMA_FILE_KEY_MAX_LENGTH, "boardId is too long to be a Figma file key")
  .regex(FIGMA_FILE_KEY_PATTERN, "boardId must be an ASCII-alphanumeric Figma file key");

/**
 * Returns the key only for canonical HTTPS Figma file URLs. URL parsing is
 * intentionally shared with ingest_board so schema validation and execution
 * cannot disagree about which host/path is trusted.
 */
export function extractFigmaFileKeyFromUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }

  const hostname = url.hostname.toLowerCase();
  const isFigmaHost = hostname === "figma.com" || hostname.endsWith(".figma.com");
  if (
    url.protocol !== "https:" ||
    !isFigmaHost ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return undefined;
  }

  const match = FIGMA_FILE_PATH_PATTERN.exec(url.pathname);
  const key = match?.[1];
  if (!key) {
    return undefined;
  }

  const parsedKey = figmaFileKeySchema.safeParse(key);
  return parsedKey.success ? parsedKey.data : undefined;
}

export const figmaFileUrlSchema = z
  .string()
  .trim()
  .max(2048, "Figma URL is too long")
  .url()
  .refine(
    (value) => extractFigmaFileKeyFromUrl(value) !== undefined,
    "Expected an HTTPS figma.com URL with path /(file|design|board|proto)/<file_key>[/name]",
  );

export const questionSchema = z
  .string()
  .trim()
  .min(1, "question must not be empty")
  .max(2000, "question must be at most 2000 characters");

export const topicSchema = z
  .string()
  .trim()
  .min(1, "topic must not be empty")
  .max(200, "topic must be at most 200 characters");
