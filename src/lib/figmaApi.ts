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
    throw new Error(
      `Figma API request failed (${response.status} ${response.statusText}): ${path}`,
    );
  }

  return response;
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
 * Used to resolve which nodes have exportable image content before
 * requesting screenshots.
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
 * Renders and downloads a PNG screenshot for the given node IDs via
 * GET /v1/images/:file_key?ids=...&format=png. The returned buffer is fed
 * into visionInterpreter.ts#refineClusterWithVision for labeling.
 *
 * The render endpoint returns one URL per node id rather than a single
 * merged image; since callers only need one screenshot per call right now,
 * this downloads the first URL that comes back.
 */
export async function fetchScreenshot(
  fileKey: string,
  nodeIds: string[],
  token: string,
): Promise<Buffer> {
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

  const imageUrl = nodeIds
    .map((id) => renderData.images?.[id])
    .find((url): url is string => Boolean(url));

  if (!imageUrl) {
    throw new Error(`Figma image render returned no URL for node IDs: ${idsParam}`);
  }

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(
      `Failed to download rendered screenshot (${imageResponse.status} ${imageResponse.statusText})`,
    );
  }

  const arrayBuffer = await imageResponse.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
