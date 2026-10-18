import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.unstubAllGlobals(); });
function json(data: unknown): Response { return new Response(JSON.stringify(data)); }
describe("bounded Figma requests", () => {
  it("reads metadata version and handles missing scope distinctly", async () => {
    const mock = vi.fn().mockResolvedValueOnce(json({ file: { version: "v2" } })).mockResolvedValueOnce(new Response("", { status: 403 }));
    vi.stubGlobal("fetch", mock);
    const { fetchFileMetadata } = await import("../src/lib/figmaApi.js");
    await expect(fetchFileMetadata("AbC123", "secret")).resolves.toEqual({ version: "v2" });
    expect(mock.mock.calls[0]?.[0]).toContain("/files/AbC123/meta");
    await expect(fetchFileMetadata("AbC123", "secret")).rejects.toMatchObject({ status: 403 });
  });
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
  it("exposes typed byte-budget and metadata-timeout errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("{}", { headers: { "Content-Length": String(65 * 1024 * 1024) } }))
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError")));
    const { fetchFileTree, fetchFileMetadata } = await import("../src/lib/figmaApi.js");
    await expect(fetchFileTree("AbC123", "secret")).rejects.toMatchObject({ name: "FigmaDownloadBudgetError" });
    const pending = fetchFileMetadata("AbC123", "secret");
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
  it("cancels a stalled screenshot body and pins renders to the captured version", async () => {
    let canceled = false;
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ images: { a: "https://cdn.example/a" } })).mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { canceled = true; } })));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRenderUrls, downloadRenders } = await import("../src/lib/figmaApi.js");
    const controller = new AbortController();
    const urls = await fetchRenderUrls("AbC123", ["a"], "secret", controller.signal, "version-1");
    const pending = downloadRenders(["a"], urls, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(canceled).toBe(true); expect(fetchMock.mock.calls[0]?.[0]).toContain("version=version-1");
  });
});
