import { readIntEnv } from "./env.js";

const FIGMA_API_BASE = "https://api.figma.com/v1";
const FIGMA_REQUEST_TIMEOUT_MS = readIntEnv("FIGMA_REQUEST_TIMEOUT_MS", 15000, 1000);
const FIGMA_FILE_REQUEST_TIMEOUT_MS = readIntEnv("FIGMA_FILE_REQUEST_TIMEOUT_MS", 60000, 1000);
const DOWNLOAD_CONCURRENCY = readIntEnv("FIGMA_SCREENSHOT_DOWNLOAD_CONCURRENCY", 3, 1);
export const FILE_MAX_BYTES = 64 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const INGEST_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
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
export async function fetchImageRefs(fileKey: string, token: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const apiPath = `/files/${fileKey}/images`;
  const data = await readJson<{ meta?: { images?: Record<string, string> }; images?: Record<string, string> }>(await figmaFetch(apiPath, token, FIGMA_REQUEST_TIMEOUT_MS, signal), apiPath, FIGMA_REQUEST_TIMEOUT_MS, signal);
  return data.meta?.images ?? data.images ?? {};
}
export async function fetchScreenshot(fileKey: string, nodeIds: string[], token: string, signal?: AbortSignal, budget?: DownloadBudget, version?: string): Promise<Buffer[]> {
  if (!nodeIds.length) throw new Error("fetchScreenshot: nodeIds must not be empty");
  const params = new URLSearchParams({ ids: nodeIds.join(","), format: "png", scale: "1" });
  if (version) params.set("version", version);
  const apiPath = `/images/${fileKey}?${params}`;
  const data = await readJson<{ images?: Record<string, string | null>; err?: string }>(await figmaFetch(apiPath, token, FIGMA_REQUEST_TIMEOUT_MS, signal), apiPath, FIGMA_REQUEST_TIMEOUT_MS, signal);
  if (data.err) throw new Error("Figma could not render the requested nodes");
  const urls = nodeIds.map(id => data.images?.[id]).filter((url): url is string => Boolean(url));
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
