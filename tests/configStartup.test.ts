import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { evidenceBoard } from "./fixtures/retrieval.js";

const tsx = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
const entrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const boardId = "StartupFixture";
let directory: string;
let cacheDirectory: string;
let preload: string;
let requestsFile: string;
let snapshotId: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "figjam-startup-"));
  cacheDirectory = path.join(directory, "cache");
  requestsFile = path.join(directory, "requests.txt");
  preload = path.join(directory, "block-network.mjs");
  await writeFile(requestsFile, "");
  await writeFile(preload, `
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async () => {
      appendFileSync(${JSON.stringify(requestsFile)}, "request\\n");
      throw new Error("Unexpected network access in offline startup test");
    };
  `);
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", cacheDirectory);
  const { persistBoard, readLatestBoard } = await import("../src/lib/persistentCache.js");
  await persistBoard({ ...evidenceBoard(boardId), cacheKey: "startup-cache" });
  snapshotId = (await readLatestBoard(boardId))!.snapshotId!;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function withServer(extra: Record<string, string>, check: (client: Client) => Promise<void>) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .filter(([name]) => !/^(?:LLM_|FIGMA_|FIGJAM_MCP_|INGEST_BOARD_|NODE_OPTIONS$)/.test(name)));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", tsx, "--import", pathToFileURL(preload).href, entrypoint],
    cwd: directory,
    env: {
      ...env, FIGJAM_MCP_CACHE_DIR: cacheDirectory,
      FIGMA_ACCESS_TOKEN: "offline-startup-figma-token", LLM_API_KEY: "offline-startup-model-key",
      LLM_BASE_URL: "https://offline-startup.invalid/v1", ...extra,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "offline-startup-test", version: "1.0.0" }, {
    supportedProtocolVersions: ["2026-07-28"], versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  try {
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("figjam-context-mcp");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(5);
    await check(client);
  } catch (error) {
    throw new Error(`Offline startup failed: ${stderr}`, { cause: error });
  } finally {
    await client.close();
    await transport.close();
  }
  expect(await readFile(requestsFile, "utf8")).toBe("");
}

describe("stdio startup with invalid environment values", () => {
  it.each([
    "LLM_ANSWER_TOP_K", "LLM_ANSWER_PROMPT_MAX_CHARS",
    "INGEST_BOARD_VISION_BUDGET_MS", "INGEST_BOARD_MIN_VISION_SLOT_MS",
    "FIGMA_REQUEST_TIMEOUT_MS", "FIGMA_FILE_REQUEST_TIMEOUT_MS", "FIGMA_SCREENSHOT_DOWNLOAD_CONCURRENCY",
    "LLM_RATE_LIMIT_RETRIES", "LLM_RATE_LIMIT_MAX_BACKOFF_MS", "LLM_SDK_MAX_RETRIES",
    "FIGJAM_MCP_MEMORY_CACHE_MAX_BOARDS", "LLM_ANSWER_MAX_OUTPUT_TOKENS", "LLM_VISION_MAX_OUTPUT_TOKENS",
    "LLM_MAX_OUTPUT_TOKENS",
  ])("starts and serves persisted context with invalid %s", async name => {
    await withServer({ [name]: "invalid" }, async client => {
      // An explicit snapshot read does not need the configurable memory-store limit.
      const context = await client.callTool({ name: "get_board_context", arguments: { boardId, snapshotId } });
      expect(context.isError).not.toBe(true);
      expect(JSON.stringify(context)).toContain("Payment retries require an idempotency key.");
    });
  }, 15_000);

  it("keeps ordinary context reads available with INGEST_BOARD_VISION_BUDGET_MS=270s and reports it from balanced ingest", async () => {
    await withServer({ INGEST_BOARD_VISION_BUDGET_MS: "270s" }, async client => {
      const context = await client.callTool({ name: "get_board_context", arguments: { boardId } });
      expect(context.isError).not.toBe(true);
      const ingest = await client.callTool({ name: "ingest_board", arguments: {
        figmaFileUrl: "https://www.figma.com/board/StartupFixture/Synthetic", ingestMode: "balanced",
      } });
      expect(ingest.isError).toBe(true);
      expect(ingest.content).toContainEqual({ type: "text", text: "INGEST_BOARD_VISION_BUDGET_MS must be an integer >= 0" });
    });
  }, 15_000);

  it.each([
    ["LLM_REQUEST_TIMEOUT_MS", 1000], ["LLM_RATE_LIMIT_RETRIES", 0],
    ["LLM_RATE_LIMIT_MAX_BACKOFF_MS", 0], ["LLM_SDK_MAX_RETRIES", 0],
  ])("returns invalid %s as a diagnostic tool error without a provider request", async (name, minimum) => {
    await withServer({ [name]: "invalid" }, async client => {
      const diagnosis = await client.callTool({ name: "diagnose_llm_config", arguments: {} });
      expect(diagnosis.isError).toBe(true);
      expect(diagnosis.content).toContainEqual({ type: "text", text: `${name} must be an integer >= ${minimum}` });
    });
  }, 15_000);
});
