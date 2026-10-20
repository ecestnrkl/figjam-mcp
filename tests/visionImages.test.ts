import { beforeEach, describe, expect, it, vi } from "vitest";
import { decode as decodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";
import { cornerColours, exifSegment, gifHeader, jpegHeader, markedJpeg, pngHeader, syntheticJpeg, syntheticPng, withOrientation } from "./fixtures/images.js";

const { resizeInWorkerMock } = vi.hoisted(() => ({ resizeInWorkerMock: vi.fn() }));
// The worker thread runs only from the built package (see package:smoke); here the same function runs inline.
vi.mock("../src/lib/imageWorker.js", () => ({ resizeInWorker: resizeInWorkerMock }));

const { imageSize, jpegOrientation, resizeToJpeg } = await import("../src/lib/imageResize.js");
const { prepareVisionImage, prepareRenders } = await import("../src/lib/visionImages.js");
const { imageMimeType } = await import("../src/lib/figmaApi.js");

const MiB = 1024 * 1024;
const jpegSize = (image: Buffer) => imageSize(image, "image/jpeg");

beforeEach(() => {
  resizeInWorkerMock.mockReset();
  resizeInWorkerMock.mockImplementation(async (data: Uint8Array, format: "image/png" | "image/jpeg", signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return resizeToJpeg(data, format);
  });
});

describe("image headers", () => {
  it("reads the pixel size of PNG, JPEG, GIF and WebP without decoding", () => {
    expect(imageSize(pngHeader(2400, 1800), "image/png")).toEqual({ width: 2400, height: 1800 });
    expect(imageSize(jpegHeader(4665, 3500), "image/jpeg")).toEqual({ width: 4665, height: 3500 });
    // Fill bytes and a progressive frame header.
    const progressive = Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xc2, 0, 11, 8, 0x03, 0x00, 0x04, 0x00, 1, 1, 0x11, 0]);
    expect(imageSize(progressive, "image/jpeg")).toEqual({ width: 1024, height: 768 });
    expect(imageSize(gifHeader(2000, 1500), "image/gif")).toEqual({ width: 2000, height: 1500 });
    const webp = (chunk: string, payload: number[]) => {
      const data = Buffer.alloc(30);
      data.write("RIFF", 0, "latin1"); data.write("WEBP", 8, "latin1"); data.write(chunk, 12, "latin1");
      data.set(payload, 20);
      return data;
    };
    expect(imageSize(webp("VP8X", [0, 0, 0, 0, 0xff, 0x07, 0, 0xff, 0x02, 0]), "image/webp")).toEqual({ width: 2048, height: 768 });
    expect(imageSize(webp("VP8L", [0x2f, 0xff, 0xc3, 0xbf, 0]), "image/webp")).toEqual({ width: 1024, height: 768 });
    expect(imageSize(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x00, 0x05, 0x00, 0x04]), "image/webp")).toEqual({ width: 1280, height: 1024 });
  });

  it("rejects headers without a usable size", () => {
    expect(imageSize(Buffer.from("\x89PNG\r\n\x1a\nbroken", "latin1"), "image/png")).toBeUndefined();
    expect(imageSize(pngHeader(0, 600), "image/png")).toBeUndefined();
    // Scan data before any frame header.
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0]), "image/jpeg")).toBeUndefined();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a]), "image/jpeg")).toBeUndefined();
    expect(imageSize(gifHeader(2000, 1500).subarray(0, 8), "image/gif")).toBeUndefined();
  });
});

describe("resizeToJpeg", () => {
  it("scales PNG and JPEG to 1,024 px on the longest side and puts transparency on white", () => {
    const fromPng = resizeToJpeg(syntheticPng(1280, 960, true), "image/png");
    expect(imageMimeType(fromPng)).toBe("image/jpeg");
    expect(jpegSize(fromPng)).toEqual({ width: 1024, height: 768 });
    const decoded = decodeJpeg(fromPng, { useTArray: true });
    const at = (x: number, y: number) => Array.from(decoded.data.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 3));
    for (const channel of at(200, 300)) expect(channel).toBeGreaterThan(245);
    expect(at(850, 330)[2]).toBeGreaterThan(150);
    expect(jpegSize(resizeToJpeg(syntheticJpeg(1280, 960), "image/jpeg"))).toEqual({ width: 1024, height: 768 });
    expect(jpegSize(resizeToJpeg(syntheticPng(960, 1280), "image/png"))).toEqual({ width: 768, height: 1024 });
  });

  it("averages the covered area instead of picking the nearest pixel", () => {
    // A one-pixel checkerboard halved in size: every target pixel covers two black and two white pixels.
    const png = new PNG({ width: 2048, height: 64 });
    for (let i = 0; i < 2048 * 64; i++) {
      const value = ((i % 2048) + Math.floor(i / 2048)) % 2 ? 255 : 0;
      png.data.fill(value, i * 4, i * 4 + 3);
      png.data[i * 4 + 3] = 255;
    }
    const decoded = decodeJpeg(resizeToJpeg(PNG.sync.write(png), "image/png"), { useTArray: true });
    expect([decoded.width, decoded.height]).toEqual([1024, 32]);
    for (const offset of [0, 4 * 1000, 4 * 20_000, decoded.data.length - 4]) {
      expect(decoded.data[offset]).toBeGreaterThan(118);
      expect(decoded.data[offset]).toBeLessThan(138);
    }
  });

  it("refuses malformed data and more than 40 megapixels", () => {
    expect(() => resizeToJpeg(pngHeader(2400, 1800, "not image data"), "image/png")).toThrow();
    expect(() => resizeToJpeg(pngHeader(10_000, 6_000), "image/png")).toThrow(/too large/);
  });
});

describe("EXIF orientation", () => {
  it("reads Orientation from big- and little-endian EXIF, after other APP1 segments", () => {
    const jpeg = jpegHeader(900, 600);
    expect(jpegOrientation(jpeg)).toBe(1);
    expect(jpegOrientation(withOrientation(jpeg, 6))).toBe(6);
    expect(jpegOrientation(withOrientation(jpeg, 8, true))).toBe(8);
    const xmp = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 12]), Buffer.from("http://ns.", "latin1")]);
    const withXmp = withOrientation(jpeg, 3);
    expect(jpegOrientation(Buffer.concat([withXmp.subarray(0, 2), xmp, withXmp.subarray(2)]))).toBe(3);
  });

  it("treats broken or truncated EXIF data as upright without an error", () => {
    const jpeg = markedJpeg(64, 48);
    const valid = withOrientation(jpeg, 6);
    const tiff = valid.subarray(12, 38);
    const broken = [
      withOrientation(jpeg, 0), withOrientation(jpeg, 9),
      exifSegment(jpeg, Buffer.concat([Buffer.from("XX", "latin1"), tiff.subarray(2)])),
      exifSegment(jpeg, Buffer.concat([tiff.subarray(0, 2), Buffer.from([0, 43]), tiff.subarray(4)])),
      exifSegment(jpeg, Buffer.concat([tiff.subarray(0, 4), Buffer.from([0x7f, 0xff, 0xff, 0xff]), tiff.subarray(8)])),
      exifSegment(jpeg, Buffer.concat([tiff.subarray(0, 8), Buffer.from([0, 0]), tiff.subarray(10)])),
      exifSegment(jpeg, Buffer.concat([tiff.subarray(0, 12), Buffer.from([0, 4]), tiff.subarray(14)])),
      exifSegment(jpeg, tiff.subarray(0, 6)),
      valid.subarray(0, 30),
    ];
    for (const image of broken) expect(jpegOrientation(image)).toBe(1);
    // An entry count beyond the segment reads only the entries inside it.
    expect(jpegOrientation(exifSegment(jpeg, Buffer.concat([tiff.subarray(0, 8), Buffer.from([0xff, 0xff]), tiff.subarray(10, 22)])))).toBe(6);
    for (const image of broken.slice(0, -1)) expect(cornerColours(resizeToJpeg(image, "image/jpeg")).topLeft).toBe("red");
  });

  it.each([
    [1, [64, 48], { topLeft: "red", topRight: "blue" }],
    [2, [64, 48], { topLeft: "blue", topRight: "red" }],
    [3, [64, 48], { bottomLeft: "blue", bottomRight: "red" }],
    [4, [64, 48], { bottomLeft: "red", bottomRight: "blue" }],
    [5, [48, 64], { topLeft: "red", bottomLeft: "blue" }],
    [6, [48, 64], { topRight: "red", bottomRight: "blue" }],
    [7, [48, 64], { topRight: "blue", bottomRight: "red" }],
    [8, [48, 64], { topLeft: "blue", bottomLeft: "red" }],
  ] as const)("turns orientation %i upright", (orientation, size, corners) => {
    expect(cornerColours(resizeToJpeg(withOrientation(markedJpeg(64, 48), orientation), "image/jpeg"))).toMatchObject({ size, ...corners });
  });
});

describe("prepareVisionImage", () => {
  it("sends an original within 1,024 px and 3.75 MiB unchanged", async () => {
    const original = jpegHeader(900, 600, "small", 200 * 1024);
    const prepared = await prepareVisionImage(original);
    expect(prepared).toEqual({ data: original });
    expect("data" in prepared && prepared.data).toBe(original);
    expect(await prepareVisionImage(gifHeader(800, 600))).toEqual({ data: gifHeader(800, 600) });
    // Broken EXIF counts as upright.
    const brokenExif = exifSegment(original, Buffer.from("MM\0+\0\0\0\x08", "latin1"));
    expect(await prepareVisionImage(brokenExif)).toEqual({ data: brokenExif });
    expect(resizeInWorkerMock).not.toHaveBeenCalled();
  });

  it("scales larger PNG and JPEG originals down on the image worker", async () => {
    for (const [original, format] of [[syntheticJpeg(1280, 960), "image/jpeg"], [syntheticPng(1280, 960), "image/png"]] as const) {
      const prepared = await prepareVisionImage(original);
      expect("data" in prepared && jpegSize(prepared.data)).toEqual({ width: 1024, height: 768 });
      expect(resizeInWorkerMock).toHaveBeenLastCalledWith(original, format, undefined);
    }
    // Within 1,024 px but above 3.75 MiB, an original is encoded again; this one fails to decode and needs a render.
    expect(await prepareVisionImage(Buffer.concat([pngHeader(1000, 800), Buffer.alloc(4 * MiB)]))).toEqual({ fallback: "unknown_format" });
    expect(resizeInWorkerMock).toHaveBeenCalledTimes(3);
  });

  it("never decodes more than 40 megapixels, malformed headers, or GIF and WebP above 1,024 px", async () => {
    expect(await prepareVisionImage(pngHeader(10_000, 6_000))).toEqual({ fallback: "too_large" });
    expect(await prepareVisionImage(jpegHeader(8_000, 6_000))).toEqual({ fallback: "too_large" });
    expect(await prepareVisionImage(Buffer.from("\x89PNG\r\n\x1a\nbroken", "latin1"))).toEqual({ fallback: "unknown_format" });
    expect(await prepareVisionImage(gifHeader(2000, 1500))).toEqual({ fallback: "too_large" });
    expect(await prepareVisionImage(Buffer.from("<svg/>"))).toEqual({ fallback: "unknown_format" });
    expect(resizeInWorkerMock).not.toHaveBeenCalled();
    // A valid header with broken data is tried once, then rendered.
    expect(await prepareVisionImage(pngHeader(2400, 1800, "broken data"))).toEqual({ fallback: "unknown_format" });
    expect(resizeInWorkerMock).toHaveBeenCalledTimes(1);
  });

  it("passes cancellation through instead of falling back to a render", async () => {
    const controller = new AbortController();
    const reason = new Error("Ingest cancelled");
    resizeInWorkerMock.mockImplementationOnce((_data: Uint8Array, _format: string, signal: AbortSignal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const pending = prepareVisionImage(pngHeader(2400, 1800), controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("bounds renders like originals and leaves out the ones it cannot bound", async () => {
    const small = pngHeader(600, 400, "render");
    const prepared = await prepareRenders([small, syntheticPng(1280, 960), pngHeader(10_000, 6_000), Buffer.from("not an image")]);
    expect(prepared[0]).toBe(small);
    expect(jpegSize(prepared[1]!)).toEqual({ width: 1024, height: 768 });
    expect(prepared.slice(2)).toEqual([undefined, undefined]);
  });
});
