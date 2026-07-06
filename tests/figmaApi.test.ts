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
});
