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
  // JPEG: the first frame header (SOF0–SOF15 except DHT, JPG and DAC).
  for (const { marker, start, end } of jpegSegments(data, view)) {
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return end - start >= 5 ? size(view.getUint16(start + 3), view.getUint16(start + 1)) : undefined;
    }
  }
  return undefined;
}

/** Marker segments of a JPEG up to its scan data; ends at malformed data. */
function* jpegSegments(data: Uint8Array, view: DataView): Generator<{ marker: number; start: number; end: number }> {
  let offset = 2;
  while (offset + 4 <= data.length && data[offset] === 0xff) {
    const marker = data[offset + 1]!;
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return;
    const length = view.getUint16(offset + 2);
    if (length < 2) return;
    yield { marker, start: offset + 4, end: Math.min(data.length, offset + 2 + length) };
    offset += 2 + length;
  }
}

/**
 * EXIF Orientation of a JPEG (tag 0x0112 in IFD0 of the first APP1 "Exif" segment): 1 is upright,
 * 2 to 8 mirror or turn the stored pixels. Missing, invalid or truncated data counts as 1.
 */
export function jpegOrientation(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (const { marker, start, end } of jpegSegments(data, view)) {
    if (marker !== 0xe1 || end - start < 14 || Buffer.from(data.subarray(start, start + 6)).toString("latin1") !== "Exif\0\0") continue;
    const tiff = start + 6;
    const order = view.getUint16(tiff);
    const little = order === 0x4949 ? true : order === 0x4d4d ? false : undefined;
    if (little === undefined || view.getUint16(tiff + 2, little) !== 42) return 1;
    const ifd = tiff + view.getUint32(tiff + 4, little);
    if (ifd + 2 > end) return 1;
    for (let entry = ifd + 2, count = view.getUint16(ifd, little); count > 0 && entry + 12 <= end; entry += 12, count--) {
      if (view.getUint16(entry, little) !== 0x0112) continue;
      const value = view.getUint16(entry + 2, little) === 3 ? view.getUint16(entry + 8, little) : 0;
      return value >= 1 && value <= 8 ? value : 1;
    }
    return 1;
  }
  return 1;
}

/** Same aspect ratio, longest side VISION_IMAGE_MAX_SIDE; smaller images keep their size. */
export function scaledSize({ width, height }: ImageSize): ImageSize {
  const scale = Math.min(1, VISION_IMAGE_MAX_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Decodes a PNG or JPEG, scales it to scaledSize with area averaging, puts
 * transparency on white, turns a JPEG upright by its EXIF orientation and
 * encodes a JPEG with quality 85. Throws on malformed data or more than
 * MAX_DECODE_PIXELS.
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
  const upright = orient(areaAverage(source.data, width, height, channels, target), target,
    format === "image/jpeg" ? jpegOrientation(data) : 1);
  return encodeJpeg(upright, JPEG_QUALITY).data;
}

/** Applies an EXIF orientation to RGBA pixels; 5 to 8 swap width and height. */
function orient(pixels: Uint8Array, { width, height }: ImageSize, orientation: number): { data: Uint8Array; width: number; height: number } {
  if (orientation < 2 || orientation > 8) return { data: pixels, width, height };
  const swap = orientation >= 5;
  const outWidth = swap ? height : width;
  const turned = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Where the stored pixel (x, y) is shown.
      const [tx, ty] = orientation === 2 ? [width - 1 - x, y] : orientation === 3 ? [width - 1 - x, height - 1 - y]
        : orientation === 4 ? [x, height - 1 - y] : orientation === 5 ? [y, x] : orientation === 6 ? [height - 1 - y, x]
        : orientation === 7 ? [height - 1 - y, width - 1 - x] : [y, width - 1 - x];
      turned.set(pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (ty * outWidth + tx) * 4);
    }
  }
  return { data: turned, width: outWidth, height: swap ? width : height };
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
