import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileKey = "PlaceholderFixture";
const fixture = {
  version: "synthetic-v1",
  document: { id: "0:0", name: "Synthetic", type: "DOCUMENT", children: [
    { id: "1:1", name: "Page", type: "CANVAS", children: [
      { id: "5:1", name: "Campus synthetic test workshop x5", type: "SECTION", absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 300 }, children: [
        { id: "5:9", name: "Campus example", type: "STICKY", characters: "Campus exercise 5: mark x next to the test.", absoluteBoundingBox: { x: 20, y: 20, width: 100, height: 100 } },
      ] },
    ] },
  ] },
};
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "figjam-placeholder-"));
  vi.stubEnv("FIGMA_ACCESS_TOKEN", "synthetic-figma-token-54321");
  vi.stubEnv("LLM_BASE_URL", "https://provider.invalid/v1");
  vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "true");
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 2, 12));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function readFixture(key: string, cacheName: string) {
  vi.resetModules();
  vi.stubEnv("LLM_API_KEY", key);
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", path.join(directory, cacheName));
  const fetchMock = vi.fn(async (request: string | URL | Request) => {
    const url = request instanceof Request ? request.url : String(request);
    expect(url).toBe(`https://api.figma.com/v1/files/${fileKey}`);
    return new Response(JSON.stringify(fixture), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { createServer } = await import("../src/server.js");
  const server = createServer();
  const client = new Client({ name: "placeholder-test", version: "1.0.0" }, { supportedProtocolVersions: ["2025-11-25"] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const ingest = await client.callTool({ name: "ingest_board", arguments: {
      figmaFileUrl: `https://www.figma.com/board/${fileKey}/Synthetic`, ingestMode: "max_speed",
    } });
    expect(ingest.isError).not.toBe(true);
    const context = await client.callTool({ name: "get_board_context", arguments: {
      boardId: fileKey, nodeIds: ["5:9"], detail: "full",
    } });
    expect(context.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return {
      ingest: { content: ingest.content, structuredContent: ingest.structuredContent },
      context: { content: context.content, structuredContent: context.structuredContent },
    };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("short placeholder credentials", () => {
  it.each(["x", "5", "Campus"])("preserves ingest and context text and structured output with LLM_API_KEY=%s", async key => {
    const baseline = await readFixture("synthetic-long-provider-key-67890", "baseline");
    const actual = await readFixture(key, "placeholder");
    expect(actual.ingest).toEqual(baseline.ingest);
    expect(actual.context).toEqual(baseline.context);
    expect(actual.ingest.structuredContent).toMatchObject({ ingestMode: "max_speed" });
    expect(JSON.stringify(actual.context)).toContain("Campus exercise 5: mark x next to the test.");
    expect(JSON.stringify(actual.context)).toContain("node-id=5%3A9");
  });

  it.each(["LLM_API_KEY", "FIGMA_ACCESS_TOKEN", "figmaAccessToken"])("validates short header tokens independently of redaction length for %s", async source => {
    const { validateHeaderSecret } = await import("../src/lib/secrets.js");
    expect(() => validateHeaderSecret("x\ny", source)).toThrow(`${source} contains characters that cannot be sent in an HTTP header`);
  });

  it.each(["LLM_API_KEY", "FIGMA_ACCESS_TOKEN", "figmaAccessToken"])("uses trimmed length 16 as the exact-redaction boundary for %s", async source => {
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("FIGMA_ACCESS_TOKEN", "");
    const { redactConfiguredSecrets } = await import("../src/lib/secrets.js");
    for (const length of [15, 16]) {
      const token = "a".repeat(length);
      const configured = ` ${token} `;
      const additional = source === "figmaAccessToken" ? [configured] : [];
      if (source !== "figmaAccessToken") vi.stubEnv(source, configured);
      expect(redactConfiguredSecrets(`value(${token})end`, additional))
        .toBe(length === 16 ? "value([redacted])end" : `value(${token})end`);
    }
  });
});
