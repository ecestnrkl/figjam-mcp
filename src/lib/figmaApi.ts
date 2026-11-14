import { describeConnectionCause } from "./connectionErrors.js";
import { readIntEnv } from "./env.js";
import { nodeProxyHint, nodeSystemCaHint } from "./nodeNetwork.js";
import { redactError, redactExternalError, redactMessage, validateHeaderSecret } from "./secrets.js";
import { describeWaitUntil, parseRetryAfter } from "./waitTime.js";

const FIGMA_API_BASE = "https://api.figma.com/v1";
export const FILE_MAX_BYTES = 64 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const INGEST_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
/** 3.75 MiB of original image are at most 5 MB as base64, a common provider limit per image. */
export const ORIGINAL_IMAGE_MAX_BYTES = 3.75 * 1024 * 1024;
export interface DownloadBudget { usedBytes: number; maxBytes: number }
export class FigmaApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number, readonly retryAt?: number,
    readonly rateLimitDetails?: string) { super(message); }
}
export class FigmaDownloadBudgetError extends Error {
  constructor() { super("Figma download exceeds the configured byte budget"); this.name = "FigmaDownloadBudgetError"; }
}
/** Figma answered a render request but gave no image URL for any requested node: it cannot render them. */
export class FigmaRenderUnavailableError extends Error {
  constructor(message = "Figma cannot render these elements: it returned no image URL for the requested nodes") { super(message); this.name = "FigmaRenderUnavailableError"; }
}
export class FigmaTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "FigmaTimeoutError"; }
}
function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
/** Figma server errors that a second request often passes. */
const RETRIED_STATUSES = new Set([500, 502, 503, 504]);
const SERVER_ERROR_WAIT_MS = 2000;
const SERVER_ERROR_MAX_RETRY_AFTER_MS = 5000;
const ERROR_TEXT_MAX_BYTES = 4096;
const ERROR_TEXT_MAX_CHARS = 200;
const FIGMA_PLAN_TIERS = new Set(["enterprise", "org", "pro", "starter", "student"]);
const FIGMA_RATE_LIMIT_TYPES = new Set(["low", "high"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
/** Figma's own error text (`err` or `message`) from a small error body; empty when there is none. */
async function readErrorText(response: Response, token: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < ERROR_TEXT_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, ERROR_TEXT_MAX_BYTES - bytes);
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
    const body = Buffer.concat(chunks, bytes).toString("utf8");
    const parsed = JSON.parse(body) as { err?: unknown; message?: unknown } | null;
    // The body is bounded above, so the whole text is redacted before it is shortened for the message.
    const text = [parsed?.err, parsed?.message].map(value => typeof value === "string"
      ? redactMessage(value, [token]).replace(/\s+/g, " ").trim() : "")
      .find(Boolean);
    return text?.slice(0, ERROR_TEXT_MAX_CHARS) ?? "";
  } catch { return ""; }
  finally { void reader.cancel().catch(() => undefined); }
}
function figmaNetworkHints(certificate = false): string {
  const hints = [nodeProxyHint(), certificate ? nodeSystemCaHint() : undefined].filter(Boolean);
  return hints.length ? ` ${hints.join(" ")}` : "";
}
function describeFigmaRateLimit(headers: Headers): string | undefined {
  const plan = headers.get("X-Figma-Plan-Tier");
  const type = headers.get("X-Figma-Rate-Limit-Type");
  const details = [plan && FIGMA_PLAN_TIERS.has(plan) && `plan tier ${plan}`,
    type && FIGMA_RATE_LIMIT_TYPES.has(type) && `rate limit type ${type}`].filter(Boolean);
  return details.length ? `Figma reports ${details.join(" and ")}.` : undefined;
}
async function figmaFetch(fileKey: string, apiPath: string, token: string, timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
  validateHeaderSecret(token, token.trim() === process.env.FIGMA_ACCESS_TOKEN?.trim() ? "FIGMA_ACCESS_TOKEN" : "figmaAccessToken");
  for (let attempt = 0; ; attempt++) {
    externalSignal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(`${FIGMA_API_BASE}${apiPath}`, { headers: { "X-Figma-Token": token.trim() }, signal: combineSignals(timeoutMs, externalSignal) });
    } catch (error) {
      externalSignal?.throwIfAborted();
      if (isTimeout(error)) throw redactError(timeoutError("Figma API request", apiPath, timeoutMs), [token]);
      const cause = describeConnectionCause(error);
      throw redactError(new Error(`Figma API request to api.figma.com failed: ${cause}. Check your network and DNS settings.${figmaNetworkHints(cause.startsWith("TLS error"))}`), [token]);
    }
    if (response.ok) return response;
    const now = Date.now();
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"), now);
    const retryAt = retryAfterMs === undefined ? undefined : now + retryAfterMs;
    const status = response.status;
    if (attempt === 0 && RETRIED_STATUSES.has(status)) {
      await response.body?.cancel();
      await sleep(retryAfterMs !== undefined && retryAfterMs <= SERVER_ERROR_MAX_RETRY_AFTER_MS ? retryAfterMs : SERVER_ERROR_WAIT_MS, externalSignal);
      continue;
    }
    let message: string;
    let rateLimitDetails: string | undefined;
    if (status === 401 || status === 403) {
      message = `Figma access denied (${status}). Check FIGMA_ACCESS_TOKEN: it must be a valid token with the scope `
        + `file_content:read, and its account must be able to open the file.`;
    } else if (status === 404) {
      message = `Figma file not found (404): ${fileKey}. Check the file key in the board URL. `
        + "Figma also answers 404 when the account of FIGMA_ACCESS_TOKEN cannot open the file, typically a company board with a personal token.";
    } else if (status === 429) {
      rateLimitDetails = describeFigmaRateLimit(response.headers);
      message = `Figma API rate limit exceeded (429). ${retryAt === undefined ? "Retry later." : `Retry after ${describeWaitUntil(retryAt, now)}.`}`
        + " Figma limits requests by seat and plan; View and Collab seats have the lowest limits."
        + (rateLimitDetails ? ` ${rateLimitDetails}` : "");
    } else if (status >= 500) {
      message = RETRIED_STATUSES.has(status)
        ? `Figma is not available right now (HTTP ${status}, repeated once). Try again in a few minutes; status.figma.com shows outages.`
        : `Figma API request failed (HTTP ${status}). Try again in a few minutes.`;
    } else {
      const text = await readErrorText(response, token);
      message = `Figma rejected the request (HTTP ${status})${text ? `: ${text}` : "."}`;
    }
    await response.body?.cancel().catch(() => undefined);
    throw new FigmaApiError(redactMessage(message, [token]), status, retryAfterMs === undefined ? undefined : Math.ceil(retryAfterMs / 1000), retryAt, rateLimitDetails);
  }
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
/** An answer that Figma sent but that cannot be used; `cause` says why in words, without parser text. */
function unreadableResponse(cause: string): Error {
  return new Error(`Figma sent an unreadable response: ${cause}. Try again in a few minutes; if it persists, check the network and status.figma.com.`);
}
function describeUnreadableBody(text: string): string {
  const start = text.trimStart();
  if (!start) return "it was empty";
  if (start.startsWith("<")) return "it was HTML, not JSON, as a proxy or login page would send";
  if (start.startsWith("{") || start.startsWith("[")) return "it was cut off before the JSON was complete";
  return "it was not JSON";
}
async function readJson<T>(response: Response, apiPath: string, timeoutMs: number, signal?: AbortSignal, token?: string): Promise<T> {
  let text: string;
  try { text = (await readBounded(response, FILE_MAX_BYTES, signal)).toString("utf8"); }
  catch (error) {
    signal?.throwIfAborted();
    if (isTimeout(error)) throw redactError(timeoutError("Figma API response body", apiPath, timeoutMs), token ? [token] : []);
    throw redactExternalError(error, typeof token === "string" ? [token] : []);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw unreadableResponse(describeUnreadableBody(text)); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unreadableResponse("it was not a JSON object");
  return parsed as T;
}
export async function fetchFileTree(fileKey: string, token: string, signal?: AbortSignal): Promise<unknown> {
  const FIGMA_FILE_REQUEST_TIMEOUT_MS = readIntEnv("FIGMA_FILE_REQUEST_TIMEOUT_MS", 45000, 1000);
  const apiPath = `/files/${fileKey}`;
  const tree = await readJson<{ document?: unknown }>(await figmaFetch(fileKey, apiPath, token, FIGMA_FILE_REQUEST_TIMEOUT_MS, signal), apiPath, FIGMA_FILE_REQUEST_TIMEOUT_MS, signal, token);
  if (!tree.document || typeof tree.document !== "object") throw unreadableResponse("it held no document");
  return tree;
}
/** One GET /v1/files/:key/images request (Tier 2): imageRef → URL of the original image, for the whole file. */
export async function fetchImageRefs(fileKey: string, token: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const FIGMA_REQUEST_TIMEOUT_MS = readIntEnv("FIGMA_REQUEST_TIMEOUT_MS", 15000, 1000);
  const apiPath = `/files/${fileKey}/images`;
  const data = await readJson<{ meta?: { images?: Record<string, string> }; images?: Record<string, string> }>(await figmaFetch(fileKey, apiPath, token, FIGMA_REQUEST_TIMEOUT_MS, signal), apiPath, FIGMA_REQUEST_TIMEOUT_MS, signal, token);
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
export type OriginalImage = { data: Buffer } | { fallback: OriginalFallbackReason };
/**
 * Downloads original images for one vision request, in priority order. Content-Length is checked before a body is
 * read: an image above `imageMaxBytes`, without URL, in an unknown format or with a failed download needs a render
 * instead. The caller bounds what is sent per request. Only the shared ingest budget and cancellation fail the whole request.
 */
export async function downloadOriginals(urls: Array<string | undefined>, imageMaxBytes: number, signal?: AbortSignal, budget?: DownloadBudget): Promise<OriginalImage[]> {
  const FIGMA_REQUEST_TIMEOUT_MS = readIntEnv("FIGMA_REQUEST_TIMEOUT_MS", 15000, 1000);
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
      else if (announced > imageMaxBytes) results.push({ fallback: "too_large" });
      else {
        if (budget && announcedBytes + announced > budget.maxBytes - budget.usedBytes) throw new FigmaDownloadBudgetError();
        if (Number.isFinite(announced)) announcedBytes += announced;
        results.push(response);
        continue;
      }
      await responses[index]?.body?.cancel();
    }
    return await Promise.all(results.map(async (result): Promise<OriginalImage> => {
      if (!(result instanceof Response)) return result;
      let data: Buffer;
      try { data = await readBounded(result, imageMaxBytes, requestSignal, budget); }
      catch (error) {
        if (error instanceof FigmaDownloadBudgetError && !(budget && budget.usedBytes > budget.maxBytes)) return { fallback: "too_large" };
        return downloadFailed(error);
      }
      return imageMimeType(data) ? { data } : { fallback: "unknown_format" };
    }));
  } catch (error) { controller.abort(error); throw error; }
}
export type RenderUrls = Record<string, string | null | undefined>;
/**
 * One GET /v1/images request (Tier 1) for all given nodes; images are downloaded separately. Without a version, Figma
 * renders the current file; a version renders its last autosave, without later nodes and edits.
 */
export async function fetchRenderUrls(fileKey: string, nodeIds: string[], token: string, signal?: AbortSignal): Promise<RenderUrls> {
  const FIGMA_REQUEST_TIMEOUT_MS = readIntEnv("FIGMA_REQUEST_TIMEOUT_MS", 15000, 1000);
  if (!nodeIds.length) throw new Error("fetchRenderUrls: nodeIds must not be empty");
  const params = new URLSearchParams({ ids: nodeIds.join(","), format: "png", scale: "1" });
  const apiPath = `/images/${fileKey}?${params}`;
  const data = await readJson<{ images?: RenderUrls; err?: string }>(await figmaFetch(fileKey, apiPath, token, FIGMA_REQUEST_TIMEOUT_MS, signal), apiPath, FIGMA_REQUEST_TIMEOUT_MS, signal, token);
  if (data.err) throw new Error("Figma could not render the requested nodes");
  return data.images ?? {};
}
/** Downloads the rendered images of `nodeIds` in order; every node needs a render URL. */
export async function downloadRenders(nodeIds: string[], renderUrls: RenderUrls, signal?: AbortSignal, budget?: DownloadBudget): Promise<Buffer[]> {
  const FIGMA_REQUEST_TIMEOUT_MS = readIntEnv("FIGMA_REQUEST_TIMEOUT_MS", 15000, 1000);
  const DOWNLOAD_CONCURRENCY = readIntEnv("FIGMA_SCREENSHOT_DOWNLOAD_CONCURRENCY", 3, 1);
  if (!nodeIds.length) throw new Error("downloadRenders: nodeIds must not be empty");
  const urls = nodeIds.map(id => renderUrls[id]).filter((url): url is string => Boolean(url));
  if (!urls.length) throw new FigmaRenderUnavailableError("Figma image render returned no URLs for the requested nodes");
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
          // These URLs are loaded without the token, so only a rate limit says anything about the Figma API; any other status means this image is unavailable.
          if (response.status !== 429) throw new Error(`Screenshot download failed (${response.status})`);
          const details = describeFigmaRateLimit(response.headers);
          throw new FigmaApiError(`Screenshot download failed (${response.status})${details ? `. ${details}` : ""}`, response.status,
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined, undefined, details);
        }
        images[current] = await readBounded(response, IMAGE_MAX_BYTES, downloadSignal, budget);
      } catch (error) {
        workerSignal.throwIfAborted();
        if (isTimeout(error)) throw new FigmaTimeoutError("Figma screenshot download timed out");
        throw redactExternalError(error);
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
  return new FigmaTimeoutError(`${operation} timed out after ${Math.round(timeoutMs / 1000)}s at api.figma.com: ${apiPath}. Check the connection or increase ${setting}.${figmaNetworkHints()}`);
}
