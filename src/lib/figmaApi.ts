/**
 * Thin wrapper around the Figma REST API (https://api.figma.com/v1).
 * All three functions use the passed-in token as the "X-Figma-Token" header.
 */

import { readIntEnv } from "./env.js";

const FIGMA_API_BASE = "https://api.figma.com/v1";
const FIGMA_REQUEST_TIMEOUT_MS = readIntEnv("FIGMA_REQUEST_TIMEOUT_MS", 15000, 1000);
const FIGMA_FILE_REQUEST_TIMEOUT_MS = readIntEnv("FIGMA_FILE_REQUEST_TIMEOUT_MS", 60000, 1000);
const SCREENSHOT_DOWNLOAD_CONCURRENCY = readIntEnv(
  "FIGMA_SCREENSHOT_DOWNLOAD_CONCURRENCY",
  3,
  1,
);

async function figmaFetch(
  path: string,
  token: string,
  timeoutMs = FIGMA_REQUEST_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${FIGMA_API_BASE}${path}`, {
      headers: { "X-Figma-Token": token },
      signal: combineAbortSignals(AbortSignal.timeout(timeoutMs), externalSignal),
    });
  } catch (error) {
    if (externalSignal?.aborted) {
      throw externalSignal.reason ?? error;
    }
    if (isTimeoutError(error)) {
      throw figmaTimeoutError("Figma API request", timeoutMs, path);
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(describeFigmaError(response, path));
  }

  return response;
}

/** Translates common Figma API failure statuses into actionable messages. */
function describeFigmaError(response: Response, path: string): string {
  const { status, statusText } = response;

  if (status === 401 || status === 403) {
    return `Figma token is invalid or expired (${status} ${statusText}). Generate a new personal access token under Figma → Settings → Security.`;
  }
  if (status === 404) {
    return `Figma file not found (404) — check the Figma file URL: ${path}`;
  }
  if (status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const hint = retryAfter
      ? ` Retry after ${retryAfter} seconds (Retry-After header).`
      : " Wait a moment before retrying.";
    return `Figma API rate limit exceeded (429).${hint}`;
  }
  return `Figma API request failed (${status} ${statusText}): ${path}`;
}

/**
 * Fetches the raw node tree for a file via GET /v1/files/:file_key.
 * Returns the untouched Figma API JSON response; normalization into
 * NormalizedNode[] happens in nodeTree.ts#flattenNodeTree.
 */
export async function fetchFileTree(fileKey: string, token: string): Promise<unknown> {
  const path = `/files/${fileKey}`;
  const response = await figmaFetch(path, token, FIGMA_FILE_REQUEST_TIMEOUT_MS);
  return readJsonResponse(response, path, FIGMA_FILE_REQUEST_TIMEOUT_MS);
}

/**
 * Fetches image fill references for a file via GET /v1/files/:file_key/images.
 * Maps imageRef → CDN URL for original bitmaps. The ingest pipeline detects
 * image content via node fills (nodeTree.ts) and screenshots via the render
 * endpoint below; this is kept for callers that need the raw source images.
 */
export async function fetchImageRefs(
  fileKey: string,
  token: string,
): Promise<Record<string, string>> {
  const path = `/files/${fileKey}/images`;
  const response = await figmaFetch(path, token);
  const data = await readJsonResponse<{ images?: Record<string, string> }>(
    response,
    path,
    FIGMA_REQUEST_TIMEOUT_MS,
  );
  return data.images ?? {};
}

/**
 * Renders and downloads PNG screenshots for the given node IDs via
 * GET /v1/images/:file_key?ids=...&format=png. The buffers are fed into
 * visionInterpreter.ts#refineClusterWithVision as separate images within a
 * single vision request.
 *
 * Figma's render endpoint returns one URL per node ID (not a composited
 * image), so this resolves to one Buffer per node ID, in the same order as
 * `nodeIds`. IDs Figma could not render (null URL — e.g. zero-size nodes)
 * are skipped; only if nothing renders at all does the call fail.
 */
export async function fetchScreenshot(
  fileKey: string,
  nodeIds: string[],
  token: string,
  signal?: AbortSignal,
): Promise<Buffer[]> {
  if (nodeIds.length === 0) {
    throw new Error("fetchScreenshot: nodeIds must not be empty");
  }

  const idsParam = nodeIds.join(",");
  const renderPath = `/images/${fileKey}?ids=${encodeURIComponent(idsParam)}&format=png`;
  const renderResponse = await figmaFetch(renderPath, token, FIGMA_REQUEST_TIMEOUT_MS, signal);
  const renderData = await readJsonResponse<{
    images?: Record<string, string | null>;
    err?: string | null;
  }>(renderResponse, renderPath, FIGMA_REQUEST_TIMEOUT_MS);

  if (renderData.err) {
    throw new Error(`Figma image render error: ${renderData.err}`);
  }

  const urls = nodeIds
    .map((id) => renderData.images?.[id])
    .filter((url): url is string => Boolean(url));

  if (urls.length === 0) {
    throw new Error(`Figma image render returned no URLs for node IDs: ${idsParam}`);
  }

  return mapWithConcurrency(urls, SCREENSHOT_DOWNLOAD_CONCURRENCY, (url) =>
    downloadImage(url, signal),
  );
}

/** Downloads a single rendered PNG from Figma's CDN into a Buffer. */
async function downloadImage(url: string, externalSignal?: AbortSignal): Promise<Buffer> {
  try {
    const imageResponse = await fetch(url, {
      signal: combineAbortSignals(
        AbortSignal.timeout(FIGMA_REQUEST_TIMEOUT_MS),
        externalSignal,
      ),
    });
    if (!imageResponse.ok) {
      throw new Error(
        `Failed to download rendered screenshot (${imageResponse.status} ${imageResponse.statusText})`,
      );
    }
    const arrayBuffer = await imageResponse.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    if (externalSignal?.aborted) {
      throw externalSignal.reason ?? error;
    }
    if (isTimeoutError(error)) {
      throw new Error(
        `Figma screenshot download timed out after ${Math.round(FIGMA_REQUEST_TIMEOUT_MS / 1000)}s`,
      );
    }
    throw error;
  }
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "TimeoutError" ||
    error instanceof Error && error.name === "AbortError"
  );
}

/** Combines the request timeout with a caller-owned phase cancellation. */
function combineAbortSignals(timeoutSignal: AbortSignal, externalSignal?: AbortSignal): AbortSignal {
  if (!externalSignal) {
    return timeoutSignal;
  }
  if (externalSignal.aborted) {
    return externalSignal;
  }

  const controller = new AbortController();
  const forwardAbort = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };
  timeoutSignal.addEventListener("abort", () => forwardAbort(timeoutSignal), { once: true });
  externalSignal.addEventListener("abort", () => forwardAbort(externalSignal), { once: true });
  return controller.signal;
}

async function readJsonResponse<T>(
  response: Response,
  path: string,
  timeoutMs: number,
): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (isTimeoutError(error)) {
      throw figmaTimeoutError("Figma API response body", timeoutMs, path);
    }
    throw error;
  }
}

function figmaTimeoutError(operation: string, timeoutMs: number, path: string): Error {
  if (path.startsWith("/files/") && !path.endsWith("/images")) {
    return new Error(
      `${operation} timed out after ${Math.round(timeoutMs / 1000)}s: ${path}. ` +
        "Increase FIGMA_FILE_REQUEST_TIMEOUT_MS if the board is large. " +
        "If your MCP client times out first, increase the client request timeout too.",
    );
  }

  return new Error(
    `${operation} timed out after ${Math.round(timeoutMs / 1000)}s: ${path}. ` +
      'Increase FIGMA_REQUEST_TIMEOUT_MS or use ingestMode "max_speed" to avoid screenshot/vision work.',
  );
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= values.length) {
        return;
      }
      results[index] = await mapper(values[index]!);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
