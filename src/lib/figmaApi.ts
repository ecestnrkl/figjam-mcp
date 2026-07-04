/**
 * Thin wrapper around the Figma REST API (https://api.figma.com/v1).
 * All three functions use the passed-in token as the "X-Figma-Token" header.
 */

const FIGMA_API_BASE = "https://api.figma.com/v1";

async function figmaFetch(path: string, token: string): Promise<Response> {
  const response = await fetch(`${FIGMA_API_BASE}${path}`, {
    headers: { "X-Figma-Token": token },
  });

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
  const response = await figmaFetch(`/files/${fileKey}`, token);
  return response.json();
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
  const response = await figmaFetch(`/files/${fileKey}/images`, token);
  const data = (await response.json()) as { images?: Record<string, string> };
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
): Promise<Buffer[]> {
  if (nodeIds.length === 0) {
    throw new Error("fetchScreenshot: nodeIds must not be empty");
  }

  const idsParam = nodeIds.join(",");
  const renderResponse = await figmaFetch(
    `/images/${fileKey}?ids=${encodeURIComponent(idsParam)}&format=png`,
    token,
  );
  const renderData = (await renderResponse.json()) as {
    images?: Record<string, string | null>;
    err?: string | null;
  };

  if (renderData.err) {
    throw new Error(`Figma image render error: ${renderData.err}`);
  }

  const urls = nodeIds
    .map((id) => renderData.images?.[id])
    .filter((url): url is string => Boolean(url));

  if (urls.length === 0) {
    throw new Error(`Figma image render returned no URLs for node IDs: ${idsParam}`);
  }

  return Promise.all(urls.map((url) => downloadImage(url)));
}

/** Downloads a single rendered PNG from Figma's CDN into a Buffer. */
async function downloadImage(url: string): Promise<Buffer> {
  const imageResponse = await fetch(url);
  if (!imageResponse.ok) {
    throw new Error(
      `Failed to download rendered screenshot (${imageResponse.status} ${imageResponse.statusText})`,
    );
  }
  const arrayBuffer = await imageResponse.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
