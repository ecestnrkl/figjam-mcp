import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = [
  ["INGEST_BOARD_VISION_BUDGET_MS", "270s", 0],
  ["INGEST_BOARD_MIN_VISION_SLOT_MS", "invalid", 0],
  ["INGEST_BOARD_VISION_CONCURRENCY", "invalid", 1],
  ["FIGMA_FILE_REQUEST_TIMEOUT_MS", "invalid", 1000],
  ["FIGMA_REQUEST_TIMEOUT_MS", "abc", 1000],
  ["FIGMA_SCREENSHOT_DOWNLOAD_CONCURRENCY", "invalid", 1],
  ["LLM_VISION_MAX_OUTPUT_TOKENS", "10", 256],
  ["LLM_VISION_REQUEST_TIMEOUT_MS", "invalid", 1000],
  ["LLM_REQUEST_TIMEOUT_MS", "invalid", 1000],
  ["LLM_RATE_LIMIT_RETRIES", "invalid", 0],
  ["LLM_RATE_LIMIT_MAX_BACKOFF_MS", "invalid", 0],
  ["LLM_SDK_MAX_RETRIES", "invalid", 0],
] as const;
const input = { figmaFileUrl: "https://www.figma.com/board/PreflightFixture/Synthetic", docStructureHint: "freeform" } as const;
let cacheDirectory: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  cacheDirectory = await mkdtemp(path.join(tmpdir(), "figjam-preflight-"));
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", cacheDirectory);
  for (const [name] of settings) vi.stubEnv(name, "");
  vi.stubEnv("FIGMA_ACCESS_TOKEN", "synthetic-figma-token");
  vi.stubEnv("LLM_BASE_URL", "https://provider.invalid/v1");
  vi.stubEnv("LLM_API_KEY", "synthetic-provider-key");
  vi.stubEnv("LLM_MODEL_PRESET", "student-free");
  vi.stubEnv("LLM_PROVIDER_REQUIRE_PARAMETERS", "true");
  // This fixture needs no vision in balanced mode; its configuration still
  // must be checked before the file request, not after inspecting the board.
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ document: {
    id: "doc", name: "Synthetic", type: "DOCUMENT", children: [
      { id: "page", name: "Page", type: "CANVAS", children: [
        { id: "1:1", name: "Text", type: "STICKY", characters: "Synthetic note", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 } },
      ] },
    ],
  } }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(cacheDirectory, { recursive: true, force: true });
});

describe.each(["balanced", "max_quality"] as const)("%s ingest configuration preflight", ingestMode => {
  it.each(settings)("rejects %s before every Figma request", async (name, value, minimum) => {
    vi.stubEnv(name, value);
    const { ingestBoard } = await import("../src/tools/ingestBoard.js");
    await expect(ingestBoard({ ...input, ingestMode })).rejects.toThrow(`${name} must be an integer >= ${minimum}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("mode-specific ingest configuration preflight", () => {
  it("max_speed ignores unused vision and transport settings", async () => {
    for (const [name, value] of settings) if (name !== "FIGMA_FILE_REQUEST_TIMEOUT_MS") vi.stubEnv(name, value);
    vi.stubEnv("LLM_MODEL_PRESET", "invalid");
    vi.stubEnv("LLM_PROVIDER_REQUIRE_PARAMETERS", "invalid");
    const { ingestBoard } = await import("../src/tools/ingestBoard.js");
    const result = await ingestBoard({ ...input, ingestMode: "max_speed" });
    expect(result.clusterCount).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("max_speed rejects its file timeout before a Figma request", async () => {
    vi.stubEnv("FIGMA_FILE_REQUEST_TIMEOUT_MS", "invalid");
    const { ingestBoard } = await import("../src/tools/ingestBoard.js");
    await expect(ingestBoard({ ...input, ingestMode: "max_speed" })).rejects.toThrow("FIGMA_FILE_REQUEST_TIMEOUT_MS must be an integer >= 1000");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the missing-LLM fallback without reading unused retry settings", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    for (const name of ["LLM_RATE_LIMIT_RETRIES", "LLM_RATE_LIMIT_MAX_BACKOFF_MS", "LLM_SDK_MAX_RETRIES"]) vi.stubEnv(name, "invalid");
    const { ingestBoard } = await import("../src/tools/ingestBoard.js");
    const result = await ingestBoard({ ...input, ingestMode: "max_quality" });
    expect(result.clusterCount).toBeGreaterThan(0);
    expect(result.qualityReport?.fallbackReasons).toHaveProperty("config");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
