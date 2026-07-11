import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("figmaApi", () => {
  it("wraps file JSON body timeouts with an actionable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockRejectedValue(new DOMException("aborted", "TimeoutError")),
      }),
    );

    const { fetchFileTree } = await import("../src/lib/figmaApi.js");

    await expect(fetchFileTree("AbC123", "token")).rejects.toThrow(
      /Figma API response body timed out.*FIGMA_FILE_REQUEST_TIMEOUT_MS/,
    );
    await expect(fetchFileTree("AbC123", "token")).rejects.not.toThrow(/max_speed/);
  });

  it("wraps screenshot body timeouts with an actionable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({ images: { "1:1": "https://cdn.test/image.png" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: vi.fn().mockRejectedValue(new DOMException("aborted", "TimeoutError")),
        }),
    );

    const { fetchScreenshot } = await import("../src/lib/figmaApi.js");

    await expect(fetchScreenshot("AbC123", ["1:1"], "token")).rejects.toThrow(
      /Figma screenshot download timed out/,
    );
  });

  it("forwards caller cancellation to the screenshot render request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchScreenshot } = await import("../src/lib/figmaApi.js");

    const request = fetchScreenshot("AbC123", ["1:1"], "token", controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await expect(request).rejects.not.toThrow(/timed out/i);
    const requestSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(requestSignal.aborted).toBe(true);
  });

  it("forwards caller cancellation to rendered screenshot downloads", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ images: { "1:1": "https://cdn.test/image.png" } }),
      })
      .mockImplementationOnce(
        (_url: string, options?: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            const signal = options?.signal;
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchScreenshot } = await import("../src/lib/figmaApi.js");

    const request = fetchScreenshot("AbC123", ["1:1"], "token", controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort(new Error("vision phase deadline"));

    await expect(request).rejects.toThrow("vision phase deadline");
    const downloadSignal = fetchMock.mock.calls[1]?.[1]?.signal as AbortSignal;
    expect(downloadSignal.aborted).toBe(true);
  });
});
