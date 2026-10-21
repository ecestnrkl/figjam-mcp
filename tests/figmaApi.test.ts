import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.unstubAllGlobals(); });
function json(data: unknown): Response { return new Response(JSON.stringify(data)); }
describe("bounded Figma requests", () => {
  it("wraps response body timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new DOMException("expired", "TimeoutError")); } }))));
    const { fetchFileTree } = await import("../src/lib/figmaApi.js");
    await expect(fetchFileTree("AbC123", "secret")).rejects.toThrow(/response body timed out.*FIGMA_FILE_REQUEST_TIMEOUT_MS/);
  });
  it("rejects an oversized file before reading its body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { headers: { "Content-Length": String(65 * 1024 * 1024) } })));
    const { fetchFileTree } = await import("../src/lib/figmaApi.js");
    await expect(fetchFileTree("AbC123", "secret")).rejects.toThrow(/byte budget/);
  });
  it("renders many nodes in one request and downloads each node's image in order", async () => {
    const mock = vi.fn().mockResolvedValueOnce(json({ images: { b: "https://cdn.example/b", a: "https://cdn.example/a", c: "https://cdn.example/c" } }))
      .mockImplementation((url: string) => Promise.resolve(new Response(url)));
    vi.stubGlobal("fetch", mock);
    const { fetchRenderUrls, downloadRenders } = await import("../src/lib/figmaApi.js");
    const urls = await fetchRenderUrls("AbC123", ["a", "b", "c"], "secret");
    expect(new URL(mock.mock.calls[0]?.[0]).searchParams.get("ids")).toBe("a,b,c");
    expect((await downloadRenders(["c", "a"], urls)).map(String)).toEqual(["https://cdn.example/c", "https://cdn.example/a"]);
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it("rejects a failed render for the whole request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ err: "private provider content", images: {} })));
    const { fetchRenderUrls } = await import("../src/lib/figmaApi.js");
    await expect(fetchRenderUrls("AbC123", ["a"], "secret")).rejects.toThrow(/could not render/);
  });
  it("enforces image and shared budgets without Content-Length", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(new Uint8Array(9 * 1024 * 1024))));
    const { downloadRenders } = await import("../src/lib/figmaApi.js");
    await expect(downloadRenders(["a"], { a: "https://cdn.example/a" })).rejects.toThrow(/byte budget/);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array(8)))));
    await expect(downloadRenders(["a", "b"], { a: "https://cdn.example/a", b: "https://cdn.example/b" }, undefined, { usedBytes: 0, maxBytes: 12 })).rejects.toThrow(/byte budget/);
  });
  it("does not treat partially missing node renderings as complete vision input", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    const { downloadRenders } = await import("../src/lib/figmaApi.js");
    await expect(downloadRenders(["a", "b"], { a: "https://cdn.example/a", b: null })).rejects.toThrow(/render was incomplete/);
    await expect(downloadRenders(["a"], {})).rejects.toThrow(/no URLs/);
    expect(mock).not.toHaveBeenCalled();
  });
  it("preserves render and download rate-limit status and cooldown without logging the body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("private provider content", { status: 429, headers: { "Retry-After": "30" } }))
      .mockResolvedValueOnce(new Response("private provider content", { status: 429, headers: { "Retry-After": "45" } })));
    const { fetchRenderUrls, downloadRenders } = await import("../src/lib/figmaApi.js");
    const render = fetchRenderUrls("AbC123", ["a"], "secret");
    await expect(render).rejects.toMatchObject({ status: 429, retryAfter: 30 });
    const pending = downloadRenders(["a"], { a: "https://cdn.example/a" });
    await expect(pending).rejects.toMatchObject({ status: 429, retryAfter: 45 });
    await expect(pending).rejects.not.toThrow(/private provider content/);
  });
  it("reads image fills with one request for the whole file", async () => {
    const mock = vi.fn().mockResolvedValueOnce(json({ error: false, status: 200, meta: { images: { ref: "https://originals.example/ref" } } }));
    vi.stubGlobal("fetch", mock);
    const { fetchImageRefs } = await import("../src/lib/figmaApi.js");
    await expect(fetchImageRefs("AbC123", "secret")).resolves.toEqual({ ref: "https://originals.example/ref" });
    expect(new URL(mock.mock.calls[0]?.[0]).pathname).toBe("/v1/files/AbC123/images");
  });
  it("identifies PNG, JPEG, GIF and WebP from their magic bytes", async () => {
    const { imageMimeType } = await import("../src/lib/figmaApi.js");
    expect(imageMimeType(Buffer.from("\x89PNG\r\n\x1a\n", "latin1"))).toBe("image/png");
    expect(imageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))).toBe("image/jpeg");
    expect(imageMimeType(Buffer.from("GIF89a", "latin1"))).toBe("image/gif");
    expect(imageMimeType(Buffer.from("RIFF\0\0\0\0WEBP", "latin1"))).toBe("image/webp");
    expect(imageMimeType(Buffer.from("<svg></svg>"))).toBeUndefined();
  });
  it("downloads originals in order and checks Content-Length before reading a body", async () => {
    const MiB = 1024 * 1024;
    const png = (size: number) => Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(size - 8)]);
    let oversizedRead = false;
    const responses: Record<string, () => Response> = {
      "https://cdn.example/large": () => new Response(new ReadableStream({ pull(controller) { oversizedRead = true; controller.close(); } }, { highWaterMark: 0 }),
        { headers: { "Content-Length": String(8 * MiB + 1) } }),
      "https://cdn.example/first": () => new Response(png(5 * MiB), { headers: { "Content-Length": String(5 * MiB) } }),
      "https://cdn.example/second": () => new Response(png(5 * MiB), { headers: { "Content-Length": String(5 * MiB) } }),
      "https://cdn.example/unannounced": () => new Response(png(9 * MiB)),
      "https://cdn.example/svg": () => new Response("<svg></svg>"),
      "https://cdn.example/gone": () => new Response("", { status: 403 }),
    };
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(responses[url]!())));
    const { downloadOriginals } = await import("../src/lib/figmaApi.js");
    const budget = { usedBytes: 0, maxBytes: 64 * MiB };
    // Up to 8 MiB per original: the caller scales large originals down and bounds each vision request itself.
    const results = await downloadOriginals([undefined, "https://cdn.example/large", "https://cdn.example/svg", "https://cdn.example/gone",
      "https://cdn.example/first", "https://cdn.example/second"], 8 * MiB, undefined, budget);
    expect(results.map(result => "data" in result ? result.data.length : result)).toEqual([
      { fallback: "missing_url" }, { fallback: "too_large" }, { fallback: "unknown_format" }, { fallback: "download_failed" }, 5 * MiB, 5 * MiB]);
    expect(oversizedRead).toBe(false);
    // The oversized announced image is never read, so it does not count against the ingest budget.
    expect(budget.usedBytes).toBe(10 * MiB + "<svg></svg>".length);
    // Without Content-Length, the per-image limit applies while reading.
    const unannounced = await downloadOriginals(["https://cdn.example/first", "https://cdn.example/unannounced"], 8 * MiB);
    expect(unannounced.map(result => "data" in result ? result.data.length : result)).toEqual([5 * MiB, { fallback: "too_large" }]);
  });
  it("fails the whole download only for the shared ingest budget", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0])))));
    const { downloadOriginals } = await import("../src/lib/figmaApi.js");
    await expect(downloadOriginals(["https://cdn.example/a", "https://cdn.example/b"], 100, undefined, { usedBytes: 0, maxBytes: 12 }))
      .rejects.toMatchObject({ name: "FigmaDownloadBudgetError" });
    // Announced sizes that together exceed the budget fail before any body is read.
    const announced = () => new Response(new Uint8Array(8), { headers: { "Content-Length": "8" } });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(announced())));
    const budget = { usedBytes: 0, maxBytes: 12 };
    await expect(downloadOriginals(["https://cdn.example/a", "https://cdn.example/b"], 100, undefined, budget))
      .rejects.toMatchObject({ name: "FigmaDownloadBudgetError" });
    expect(budget.usedBytes).toBe(0);
  });
  it("exposes typed byte-budget and request-timeout errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("{}", { headers: { "Content-Length": String(65 * 1024 * 1024) } }))
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError")));
    const { fetchFileTree, fetchImageRefs } = await import("../src/lib/figmaApi.js");
    await expect(fetchFileTree("AbC123", "secret")).rejects.toMatchObject({ name: "FigmaDownloadBudgetError" });
    const pending = fetchImageRefs("AbC123", "secret");
    await expect(pending).rejects.toMatchObject({ name: "FigmaTimeoutError" });
    await expect(pending).rejects.toThrow(/FIGMA_REQUEST_TIMEOUT_MS/);
  });
  it("propagates caller cancellation to file and screenshot fetches", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchFileTree, fetchRenderUrls, downloadRenders } = await import("../src/lib/figmaApi.js");
    for (const request of [(signal: AbortSignal) => fetchFileTree("AbC123", "secret", signal), (signal: AbortSignal) => fetchRenderUrls("AbC123", ["a"], "secret", signal),
      (signal: AbortSignal) => downloadRenders(["a"], { a: "https://cdn.example/a" }, signal)]) {
      const controller = new AbortController(); const pending = request(controller.signal); controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchMock.mock.calls.at(-1)?.[1].signal.aborted).toBe(true);
    }
  });
  it("cancels a stalled screenshot body and renders the current file", async () => {
    let canceled = false;
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ images: { a: "https://cdn.example/a" } })).mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { canceled = true; } })));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRenderUrls, downloadRenders } = await import("../src/lib/figmaApi.js");
    const controller = new AbortController();
    const urls = await fetchRenderUrls("AbC123", ["a"], "secret", controller.signal);
    const pending = downloadRenders(["a"], urls, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(canceled).toBe(true); expect(fetchMock.mock.calls[0]?.[0]).not.toContain("version=");
  });
});
