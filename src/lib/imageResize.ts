import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";

/**
 * Pure image helpers for the vision request. They run on the image worker
 * thread (imageWorker.ts); tests may call them directly.
 */

/** Longest side of every image sent to a vision model. */
export const VISION_IMAGE_MAX_SIDE = 1024;
/** Larger images are never decoded: 40 MP of RGBA alone are 160 MB. */
export const MAX_DECODE_PIXELS = 40_000_000;
const JPEG_QUALITY = 85;

export type ResizableFormat = "image/png" | "image/jpeg";
export type HeaderFormat = ResizableFormat | "image/gif" | "image/webp";
export interface ImageSize { width: number; height: number }

/** Pixel size from the file header, without decoding; undefined for malformed headers. */
export function imageSize(data: Uint8Array, format: HeaderFormat): ImageSize | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ascii = (start: number, end: number) => Buffer.from(data.subarray(start, end)).toString("latin1");
  const size = (width: number, height: number) => width > 0 && height > 0 ? { width, height } : undefined;
  if (format === "image/png") return data.length >= 24 && ascii(12, 16) === "IHDR" ? size(view.getUint32(16), view.getUint32(20)) : undefined;
  if (format === "image/gif") return data.length >= 10 ? size(view.getUint16(6, true), view.getUint16(8, true)) : undefined;
  if (format === "image/webp") {
    if (data.length < 30) return undefined;
    const chunk = ascii(12, 16);
    const uint24 = (offset: number) => data[offset]! | data[offset + 1]! << 8 | data[offset + 2]! << 16;
    if (chunk === "VP8X") return size(1 + uint24(24), 1 + uint24(27));
    if (chunk === "VP8L" && data[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return size(1 + (bits & 0x3fff), 1 + (bits >>> 14 & 0x3fff));
    }
    if (chunk === "VP8 " && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
    return undefined;
  }
  // JPEG: walk the marker segments up to the first frame header (SOF0–SOF15 except DHT, JPG and DAC).
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return undefined;
    const marker = data[offset + 1]!;
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return offset + 9 <= data.length ? size(view.getUint16(offset + 7), view.getUint16(offset + 5)) : undefined;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

/** Same aspect ratio, longest side VISION_IMAGE_MAX_SIDE; smaller images keep their size. */
export function scaledSize({ width, height }: ImageSize): ImageSize {
  const scale = Math.min(1, VISION_IMAGE_MAX_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Decodes a PNG or JPEG, scales it to scaledSize with area averaging, puts
 * transparency on white and encodes a JPEG with quality 85. Throws on
 * malformed data or more than MAX_DECODE_PIXELS.
 */
export function resizeToJpeg(data: Uint8Array, format: ResizableFormat): Buffer {
  const header = imageSize(data, format);
  if (!header || header.width * header.height > MAX_DECODE_PIXELS) throw new Error("Image header is malformed or too large to decode");
  const source = format === "image/png"
    ? PNG.sync.read(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    : decodeJpeg(data, { useTArray: true, formatAsRGBA: false, maxResolutionInMP: MAX_DECODE_PIXELS / 1e6 });
  const { width, height } = source;
  if (width !== header.width || height !== header.height) throw new Error("Decoded image size does not match its header");
  const channels = source.data.length / (width * height);
  if (channels !== 3 && channels !== 4) throw new Error("Unsupported decoded pixel layout");
  const target = scaledSize(header);
  const pixels = areaAverage(source.data, width, height, channels, target);
  return encodeJpeg({ data: pixels, width: target.width, height: target.height }, JPEG_QUALITY).data;
}

/**
 * Box filter over the exact source area of each target pixel. As the image
 * only shrinks, a source pixel overlaps at most two target pixels per axis.
 */
function areaAverage(source: Uint8Array, width: number, height: number, channels: number, target: ImageSize): Uint8Array {
  const columns = coverage(width, target.width);
  const rows = coverage(height, target.height);
  const rowStride = target.width * 3;
  const sums = new Float32Array(rowStride * target.height);
  const row = new Float32Array(rowStride);
  for (let y = 0; y < height; y++) {
    row.fill(0);
    for (let x = 0, p = y * width * channels; x < width; x++, p += channels) {
      // Transparency goes on white before averaging.
      const alpha = channels === 4 ? source[p + 3]! / 255 : 1;
      const white = 255 * (1 - alpha);
      const r = source[p]! * alpha + white, g = source[p + 1]! * alpha + white, b = source[p + 2]! * alpha + white;
      const o = columns.index[x]! * 3, share = columns.share[x]!;
      row[o]! += r * share; row[o + 1]! += g * share; row[o + 2]! += b * share;
      if (share < 1) {
        const rest = 1 - share;
        row[o + 3]! += r * rest; row[o + 4]! += g * rest; row[o + 5]! += b * rest;
      }
    }
    const t = rows.index[y]! * rowStride, share = rows.share[y]!;
    for (let i = 0; i < rowStride; i++) sums[t + i]! += row[i]! * share;
    if (share < 1) for (let i = 0, rest = 1 - share; i < rowStride; i++) sums[t + rowStride + i]! += row[i]! * rest;
  }
  const area = (width / target.width) * (height / target.height);
  const pixels = new Uint8Array(target.width * target.height * 4);
  for (let i = 0, o = 0; i < sums.length; i += 3, o += 4) {
    pixels[o] = Math.min(255, Math.round(sums[i]! / area));
    pixels[o + 1] = Math.min(255, Math.round(sums[i + 1]! / area));
    pixels[o + 2] = Math.min(255, Math.round(sums[i + 2]! / area));
    pixels[o + 3] = 255;
  }
  return pixels;
}

/** Per source pixel: its first target pixel and the share of it inside; the rest goes to the next one. */
function coverage(sourceLength: number, targetLength: number): { index: Uint32Array; share: Float32Array } {
  const ratio = sourceLength / targetLength;
  const index = new Uint32Array(sourceLength);
  const share = new Float32Array(sourceLength);
  for (let i = 0; i < sourceLength; i++) {
    const first = Math.min(targetLength - 1, Math.floor(i / ratio));
    index[i] = first;
    share[i] = first === targetLength - 1 ? 1 : Math.max(0, Math.min(1, (first + 1) * ratio - i));
  }
  return { index, share };
}
