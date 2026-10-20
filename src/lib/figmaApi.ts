import { readIntEnv } from "./env.js";

const FIGMA_API_BASE = "https://api.figma.com/v1";
const FIGMA_REQUEST_TIMEOUT_MS = readIntEnv("FIGMA_REQUEST_TIMEOUT_MS", 15000, 1000);
const FIGMA_FILE_REQUEST_TIMEOUT_MS = readIntEnv("FIGMA_FILE_REQUEST_TIMEOUT_MS", 60000, 1000);
const DOWNLOAD_CONCURRENCY = readIntEnv("FIGMA_SCREENSHOT_DOWNLOAD_CONCURRENCY", 3, 1);
export const FILE_MAX_BYTES = 64 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const INGEST_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
/** 3.75 MiB of original image are at most 5 MB as base64, a common provider limit per image. */
export const ORIGINAL_IMAGE_MAX_BYTES = 3.75 * 1024 * 1024;
export interface DownloadBudget { usedBytes: number; maxBytes: number }
export class FigmaApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) { super(message); }
}
export class FigmaDownloadBudgetError extends Error {
  constructor() { super("Figma download exceeds the configured byte budget"); this.name = "FigmaDownloadBudgetError"; }
}
export class FigmaTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "FigmaTimeoutError"; }
}
function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
async function figmaFetch(apiPath: string, token: string, timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
  externalSignal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(`${FIGMA_API_BASE}${apiPath}`, { headers: { "X-Figma-Token": token }, signal: combineSignals(timeoutMs, externalSignal) });
  } catch (error) {
    externalSignal?.throwIfAborted();
    if (isTimeout(error)) throw timeoutError("Figma API request", apiPath, timeoutMs);
    throw error;
  }
  if (!response.ok) {
    const retryAfter = Number(response.headers.get("Retry-After"));
    const message = response.status === 401 || response.status === 403
      ? `Figma access denied (${response.status}). Check the token, file permission and required scopes.`
      : response.status === 404 ? `Figma file not found (404): ${apiPath}`
      : response.status === 429 ? `Figma API rate limit exceeded (429).${retryAfter > 0 ? ` Retry after ${retryAfter} seconds.` : " Retry later."}`
      : `Figma API request failed (${response.status} ${response.statusText}): ${apiPath}`;
    await response.body?.cancel();
    throw new FigmaApiError(message, response.status, retryAfter > 0 ? retryAfter : undefined);
  }
  return response;
}
/** Enforces the limit while streaming, including servers that omit Content-Length. */
async function readBounded(response: Response, maxBytes: number, signal?: AbortSignal, budget?: DownloadBudget): Promise<Buffer> {
  signal?.throwIfAborted();
  const announced = Number(response.headers.get("Content-Length"));
  if (announced > maxBytes || (budget && announced > budget.maxBytes - budget.usedBytes)) {
    await response.body?.cancel();
    throw new FigmaDownloadBudgetError();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (budget) budget.usedBytes += value.byteLength;
      if (bytes > maxBytes || (budget && budget.usedBytes > budget.maxBytes)) {
        await reader.cancel();
        throw new FigmaDownloadBudgetError();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
async function readJson<T>(response: Response, apiPath: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  try { return JSON.parse((await readBounded(response, FILE_MAX_BYTES, signal)).toString("utf8")) as T; }
  catch (error) {
    signal?.throwIfAborted();
    if (isTimeout(error)) throw timeoutError("Figma API response body", apiPath, timeoutMs);
    throw error;
  }
}
export async function fetchFileTree(fileKey: string, token: string, signal?: AbortSignal): Promise<unknown> {
  const apiPath = `/files/${fileKey}`;
  return readJson(await figmaFetch(apiPath, token, FIGMA_FILE_REQUEST_TIMEOUT_MS, signal), apiPath, FIGMA_FILE_REQUEST_TIMEOUT_MS, signal);
}
export async function fetchFileMetadata(fileKey: string, token: string, signal?: AbortSignal): Promise<{ version: string }> {
  const apiPath = `/files/${fileKey}/meta`;
  const data = await readJson<{ file?: { version?: unknown } }>(await figmaFetch(apiPath, token, FIGMA_REQUEST_TIMEOUT_MS, signal), apiPath, FIGMA_REQUEST_TIMEOUT_MS, signal);
  if (typeof data.file?.version !== "string" || !data.file.version) throw new Error("Figma metadata did not include a file version; freshness cannot be confirmed");
  return { version: data.file.version };
}
/** One GET /v1/files/:key/images request (Tier 2): imageRef → URL of the original image, for the whole file. */
export async function fetchImageRefs(fileKey: string, token: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const apiPath = `/files/${fileKey}/images`;
  const data = await readJson<{ meta?: { images?: Record<string, string> }; images?: Record<string, string> }>(await figmaFetch(apiPath, token, FIGMA_REQUEST_TIMEOUT_MS, signal), apiPath, FIGMA_REQUEST_TIMEOUT_MS, signal);
  return data.meta?.images ?? data.images ?? {};
}
export type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
/** Identifies the formats vision models accept from their magic bytes. */
export function imageMimeType(data: Uint8Array): ImageMimeType | undefined {
  const ascii = (start: number, end: number) => Buffer.from(data.subarray(start, end)).toString("latin1");
  if (data.length >= 8 && ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (data.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}
/** Why an original image is replaced by a render of its node. */
export type OriginalFallbackReason = "missing_url" | "too_large" | "unknown_format" | "download_failed";
export type OriginalImage = { data: Buffer } | { fallback: OriginalFallbackReason } | { skipped: true };
export interface OriginalImageLimits { imageMaxBytes: number; requestMaxBytes: number }
/**
 * Downloads original images for one vision request, in priority order. Content-Length is checked before a body is
 * read: an image above `imageMaxBytes`, without URL, in an unknown format or with a failed download needs a render
 * instead; an image that would push the request above `requestMaxBytes` is skipped once an earlier one is kept.
 * Only the shared ingest budget and cancellation fail the whole request.
 */
export async function downloadOriginals(urls: Array<string | undefined>, limits: OriginalImageLimits, signal?: AbortSignal, budget?: DownloadBudget): Promise<OriginalImage[]> {
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const downloadFailed = (error: unknown): OriginalImage => {
    requestSignal.throwIfAborted();
    if (error instanceof FigmaDownloadBudgetError) throw error;
    return { fallback: "download_failed" };
  };
  try {
    // Opening all responses first overlaps their latency; bodies are read only after the size check.
    const responses = await Promise.all(urls.map(async url => {
      if (!url) return undefined;
      try {
        const response = await fetch(url, { signal: combineSignals(FIGMA_REQUEST_TIMEOUT_MS, requestSignal) });
        if (response.ok) return response;
        await response.body?.cancel();
      } catch { requestSignal.throwIfAborted(); }
      return null;
    }));
    const results: Array<OriginalImage | Response> = [];
    let announcedBytes = 0;
    for (const [index, response] of responses.entries()) {
      const announced = Number(response?.headers.get("Content-Length") || NaN);
      if (response === undefined) results.push({ fallback: "missing_url" });
      else if (response === null) results.push({ fallback: "download_failed" });
      else if (announced > limits.imageMaxBytes) results.push({ fallback: "too_large" });
      else if (announced + announcedBytes > limits.requestMaxBytes && results.some(result => result instanceof Response)) results.push({ skipped: true });
      else {
        if (budget && announced > budget.maxBytes - budget.usedBytes) throw new FigmaDownloadBudgetError();
        if (Number.isFinite(announced)) announcedBytes += announced;
        results.push(response);
        continue;
      }
      await responses[index]?.body?.cancel();
    }
    const read = await Promise.all(results.map(async (result): Promise<OriginalImage> => {
      if (!(result instanceof Response)) return result;
      let data: Buffer;
      try { data = await readBounded(result, limits.imageMaxBytes, requestSignal, budget); }
      catch (error) {
        if (error instanceof FigmaDownloadBudgetError && !(budget && budget.usedBytes > budget.maxBytes)) return { fallback: "too_large" };
        return downloadFailed(error);
      }
      return imageMimeType(data) ? { data } : { fallback: "unknown_format" };
    }));
    // Servers that omit or misstate Content-Length are held to the request limit after reading.
    let requestBytes = 0;
    return read.map(result => {
      if (!("data" in result)) return result;
      if (requestBytes > 0 && requestBytes + result.data.byteLength > limits.requestMaxBytes) return { skipped: true };
      requestBytes += result.data.byteLength;
      return result;
    });
  } catch (error) { controller.abort(error); throw error; }
}
export type RenderUrls = Record<string, string | null | undefined>;
/** One GET /v1/images request (Tier 1) for all given nodes; images are downloaded separately. */
export async function fetchRenderUrls(fileKey: string, nodeIds: string[], token: string, signal?: AbortSignal, version?: string): Promise<RenderUrls> {
  if (!nodeIds.length) throw new Error("fetchRenderUrls: nodeIds must not be empty");
  const params = new URLSearchParams({ ids: nodeIds.join(","), format: "png", scale: "1" });
  if (version) params.set("version", version);
  const apiPath = `/images/${fileKey}?${params}`;
  const data = await readJson<{ images?: RenderUrls; err?: string }>(await figmaFetch(apiPath, token, FIGMA_REQUEST_TIMEOUT_MS, signal), apiPath, FIGMA_REQUEST_TIMEOUT_MS, signal);
  if (data.err) throw new Error("Figma could not render the requested nodes");
  return data.images ?? {};
}
/** Downloads the rendered images of `nodeIds` in order; every node needs a render URL. */
export async function downloadRenders(nodeIds: string[], renderUrls: RenderUrls, signal?: AbortSignal, budget?: DownloadBudget): Promise<Buffer[]> {
  if (!nodeIds.length) throw new Error("downloadRenders: nodeIds must not be empty");
  const urls = nodeIds.map(id => renderUrls[id]).filter((url): url is string => Boolean(url));
  if (!urls.length) throw new Error("Figma image render returned no URLs for the requested nodes");
  if (urls.length !== nodeIds.length) throw new Error("Figma image render was incomplete; some requested nodes have no image URL");
  let index = 0;
  const images: Buffer[] = [];
  const controller = new AbortController();
  const workerSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  async function worker(): Promise<void> {
    for (;;) {
      workerSignal.throwIfAborted();
      const current = index++;
      if (current >= urls.length) return;
      try {
        const downloadSignal = combineSignals(FIGMA_REQUEST_TIMEOUT_MS, workerSignal);
        const response = await fetch(urls[current]!, { signal: downloadSignal });
        if (!response.ok) {
          const retryAfter = Number(response.headers.get("Retry-After"));
          await response.body?.cancel();
          throw new FigmaApiError(`Screenshot download failed (${response.status})`, response.status,
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
        }
        images[current] = await readBounded(response, IMAGE_MAX_BYTES, downloadSignal, budget);
      } catch (error) {
        workerSignal.throwIfAborted();
        if (isTimeout(error)) throw new FigmaTimeoutError("Figma screenshot download timed out");
        throw error;
      }
    }
  }
  try { await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, urls.length) }, worker)); }
  catch (error) { controller.abort(error); throw error; }
  return images;
}
function isTimeout(error: unknown): boolean { return error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name); }
function timeoutError(operation: string, apiPath: string, timeoutMs: number): FigmaTimeoutError {
  const setting = /^\/files\/[^/?]+$/.test(apiPath) ? "FIGMA_FILE_REQUEST_TIMEOUT_MS" : "FIGMA_REQUEST_TIMEOUT_MS";
  return new FigmaTimeoutError(`${operation} timed out after ${Math.round(timeoutMs / 1000)}s: ${apiPath}. Check the connection or increase ${setting}.`);
}
