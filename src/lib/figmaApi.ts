/**
 * Thin wrapper around the Figma REST API (https://api.figma.com/v1).
 * All three functions will later use FIGMA_ACCESS_TOKEN / the per-call
 * token as the "X-Figma-Token" header.
 */

/**
 * Fetches the raw node tree for a file via GET /v1/files/:file_key.
 * Returns the untouched Figma API JSON response; normalization into
 * NormalizedNode[] happens in nodeTree.ts#flattenNodeTree.
 */
export async function fetchFileTree(fileKey: string, token: string): Promise<unknown> {
  // TODO: implement — siehe Folge-Prompt
  throw new Error("Not implemented");
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
  // TODO: implement — siehe Folge-Prompt
  throw new Error("Not implemented");
}

/**
 * Renders and downloads a PNG screenshot for the given node IDs via
 * GET /v1/images/:file_key?ids=...&format=png. The returned buffer is fed
 * into visionInterpreter.ts#refineClusterWithVision for labeling.
 */
export async function fetchScreenshot(
  fileKey: string,
  nodeIds: string[],
  token: string,
): Promise<Buffer> {
  // TODO: implement — siehe Folge-Prompt
  throw new Error("Not implemented");
}
