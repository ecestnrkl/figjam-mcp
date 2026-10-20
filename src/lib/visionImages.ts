import { imageMimeType, ORIGINAL_IMAGE_MAX_BYTES, type OriginalFallbackReason } from "./figmaApi.js";
import { imageSize, MAX_DECODE_PIXELS, VISION_IMAGE_MAX_SIDE } from "./imageResize.js";
import { resizeInWorker } from "./imageWorker.js";

export type VisionImage = { data: Buffer } | { fallback: Extract<OriginalFallbackReason, "too_large" | "unknown_format"> };

/**
 * Bounds one image for a vision request: at most VISION_IMAGE_MAX_SIDE pixels
 * on the longest side and ORIGINAL_IMAGE_MAX_BYTES. An image within both goes
 * unchanged. A larger PNG or JPEG is scaled down on the image worker and sent
 * as JPEG. GIF and WebP above the bounds, malformed data and more than
 * MAX_DECODE_PIXELS are never decoded and need a render instead.
 */
export async function prepareVisionImage(data: Buffer, signal?: AbortSignal): Promise<VisionImage> {
  const format = imageMimeType(data);
  const size = format ? imageSize(data, format) : undefined;
  if (!format || !size) return { fallback: "unknown_format" };
  if (Math.max(size.width, size.height) <= VISION_IMAGE_MAX_SIDE && data.byteLength <= ORIGINAL_IMAGE_MAX_BYTES) return { data };
  if ((format !== "image/png" && format !== "image/jpeg") || size.width * size.height > MAX_DECODE_PIXELS) return { fallback: "too_large" };
  try {
    return { data: await resizeInWorker(data, format, signal) };
  } catch {
    signal?.throwIfAborted();
    return { fallback: "unknown_format" };
  }
}

/** Renders bounded like originals, one after another; a render that cannot be bounded is undefined. */
export async function prepareRenders(renders: Buffer[], signal?: AbortSignal): Promise<Array<Buffer | undefined>> {
  const prepared: Array<Buffer | undefined> = [];
  for (const render of renders) {
    const image = await prepareVisionImage(render, signal);
    prepared.push("data" in image ? image.data : undefined);
  }
  return prepared;
}
