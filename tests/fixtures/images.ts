import { encode as encodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";

/** Synthetic images for the vision image path; no real board content. */

/** PNG signature and IHDR with the given size, then `tag`; enough for header checks, not decodable. */
export function pngHeader(width: number, height: number, tag = ""): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.set([8, 6, 0, 0, 0], 16);
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), ihdr, Buffer.from(tag)]);
}

/** JPEG with APP0 and a baseline frame header of the given size, then `tag`, padded to `size` bytes; not decodable. */
export function jpegHeader(width: number, height: number, tag = "", size = 0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const header = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from(tag)]);
  return size > header.length ? Buffer.concat([header, Buffer.alloc(size - header.length)]) : header;
}

export function gifHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "latin1");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header;
}

/** Colour blocks with a grid; the left half is transparent when `alpha` is set. */
function pixels(width: number, height: number, alpha: boolean): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const block = (Math.floor(x * 6 / width) + Math.floor(y * 4 / height)) % 3;
      const line = x % 100 < 2 || y % 100 < 2;
      data[o] = line ? 0 : block === 0 ? 220 : 40;
      data[o + 1] = line ? 0 : block === 1 ? 200 : 60;
      data[o + 2] = line ? 0 : block === 2 ? 230 : 50;
      data[o + 3] = alpha && x < width / 2 ? 0 : 255;
    }
  }
  return data;
}

// Encoding takes CPU time that parallel test files share, so each image is made once.
const made = new Map<string, Buffer>();
function once(key: string, make: () => Buffer): Buffer {
  let image = made.get(key);
  if (!image) made.set(key, image = make());
  return image;
}

export function syntheticPng(width: number, height: number, alpha = false): Buffer {
  return once(`png ${width} ${height} ${alpha}`, () => {
    const png = new PNG({ width, height });
    pixels(width, height, alpha).copy(png.data);
    return PNG.sync.write(png);
  });
}

export function syntheticJpeg(width: number, height: number): Buffer {
  return once(`jpeg ${width} ${height}`, () => encodeJpeg({ data: pixels(width, height, false), width, height }, 90).data);
}
