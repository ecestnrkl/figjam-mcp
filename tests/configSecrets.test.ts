import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceBoard } from "./fixtures/retrieval.js";
import { pngHeader } from "./fixtures/images.js";

const apiKey = "u79Qe5n2Vb40p6zYx3W8";
const figmaKey = "r84Gs2c7Jw91h5qZa6N0";
const argumentKey = "a65Yt3p8Ln20v4xHe7B9";
const input = { figmaFileUrl: "https://www.figma.com/board/SyntheticSecrets/Fixture", ingestMode: "max_quality", docStructureHint: "freeform" } as const;
let directory: string;
let fetchMock: ReturnType<typeof vi.fn>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  vi.resetModules();
  directory = await mkdtemp(path.join(tmpdir(), "figjam-config-secrets-"));
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", directory);
  vi.stubEnv("FIGMA_ACCESS_TOKEN", figmaKey);
  vi.stubEnv("LLM_API_KEY", apiKey);
  vi.stubEnv("LLM_BASE_URL", "https://provider.invalid/v1");
  vi.stubEnv("LLM_MODEL_PRESET", "student-free");
  vi.stubEnv("LLM_TEXT_MODELS", "fixture-text");
  vi.stubEnv("LLM_FAST_TEXT_MODELS", "fixture-fast");
  vi.stubEnv("LLM_VISION_MODELS", "fixture-vision");
  vi.stubEnv("LLM_RATE_LIMIT_RETRIES", "0");
  vi.stubEnv("LLM_SDK_MAX_RETRIES", "0");
  vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "false");
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock = vi.fn(async (request: string | URL | Request) => {
    const url = new URL(request instanceof Request ? request.url : String(request));
    if (url.hostname === "provider.invalid") {
      return json({ error: { message: `Incorrect API key provided: ${apiKey}; also ${figmaKey}`, code: "invalid_api_key" } }, 401);
    }
    if (url.hostname === "api.figma.com" && url.pathname === "/v1/files/SyntheticSecrets") {
      return json({ document: { id: "doc", name: "Synthetic", type: "DOCUMENT", children: [
        { id: "page", name: "Page", type: "CANVAS", children: [
          { id: "1:1", name: "Synthetic image", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, fills: [{ type: "IMAGE", imageRef: "fixture" }] },
        ] },
      ] } });
    }
    if (url.pathname === "/v1/files/SyntheticSecrets/images") return json({ meta: { images: { fixture: "https://images.invalid/fixture" } } });
    if (url.hostname === "images.invalid") return new Response(pngHeader(100, 100, "synthetic"));
    throw new Error("Unexpected mocked request");
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function expectNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [apiKey, figmaKey, argumentKey]) expect(text).not.toContain(secret);
}

describe("configured secrets at external error boundaries", () => {
  it("preserves actionable token configuration names while applying board-only underscore redaction", async () => {
    vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "true");
    const { redactMessage } = await import("../src/lib/secrets.js");
    const { redactCredentials } = await import("../src/lib/redact.js");
    const message = "Figma access denied (401). Check FIGMA_ACCESS_TOKEN: it must be valid and have file_content:read scope.";
    expect(redactMessage(message)).toBe(message);
    expect(redactCredentials("aws_secret_access_key = synthetic-secret")).toBe("aws_secret_access_key = [redacted]");
  });

  it.each(["Passwort: synthetic-secret", "PIN: alphabetical-secret", "API key = synthetic-secret"])("retains labelled credential filtering in errors: %s", async message => {
    vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "true");
    const { redactMessage } = await import("../src/lib/secrets.js");
    expect(redactMessage(message)).toBe(message.replace(/(?<=[:=] ).*/, "[redacted]"));
  });

  it("retains recognizable key and private-key filtering in errors", async () => {
    vi.stubEnv("FIGJAM_MCP_REDACT_CREDENTIALS", "true");
    const { redactMessage } = await import("../src/lib/secrets.js");
    const key = "ghp_" + "synthetic1234567890";
    const pem = ["-----BEGIN PRIVATE KEY-----", "synthetic", "-----END PRIVATE KEY-----"].join("\n");
    expect(redactMessage(`Failure ${key}; key block:\n${pem}\nRetry.`)).toBe("Failure [redacted]; key block:\n[redacted]\nRetry.");
  });

  it("hides arbitrary keys in provider-401 diagnosis, answer, ingest summary and stderr", async () => {
    const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");
    const diagnosis = await diagnoseLlmConfig();
    expect(diagnosis.ok).toBe(false);
    expect(diagnosis.summary).toContain("[redacted]");
    for (const check of diagnosis.checks) {
      expect(check.error).toContain("[redacted]");
      expect(check.attempts?.[0]?.error).toContain("[redacted]");
    }
    expectNoSecrets(diagnosis);
    const { setBoard } = await import("../src/lib/cache.js");
    const board = evidenceBoard("SyntheticAnswer");
    setBoard(board.boardId, board);
    const { answerFromBoard } = await import("../src/tools/answerFromBoard.js");
    await expect(answerFromBoard({ boardId: board.boardId, question: "Payment retries?" })).rejects.toThrow("HTTP 401");
    const { ingestBoard } = await import("../src/tools/ingestBoard.js");
    const ingest = await ingestBoard({ ...input, figmaAccessToken: argumentKey });
    expect(ingest.qualityReport?.fallbackReasons).toHaveProperty("auth");
    expectNoSecrets(ingest);
    expectNoSecrets(vi.mocked(console.error).mock.calls);
  });

  it.each(["line\nbreak", "“smart-quotes”", "zero\u200bwidth", "control\u0001character"])("rejects figmaAccessToken %j before any request", async token => {
    const { ingestBoard } = await import("../src/tools/ingestBoard.js");
    const pending = ingestBoard({ ...input, figmaAccessToken: token });
    await expect(pending).rejects.toThrow("figmaAccessToken contains characters that cannot be sent in an HTTP header, such as smart quotes or a line break. Copy the token again.");
    await pending.catch(error => expect(error.message).not.toContain(token));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["FIGMA_ACCESS_TOKEN", "LLM_API_KEY"])("names %s with invalid header characters before Figma or provider requests", async name => {
    vi.stubEnv(name, "“synthetic\u200bsecret”");
    const { ingestBoard } = await import("../src/tools/ingestBoard.js");
    await expect(ingestBoard(input)).rejects.toThrow(`${name} contains characters that cannot be sent in an HTTP header, such as smart quotes or a line break. Copy the token again.`);
    if (name === "LLM_API_KEY") {
      const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");
      const diagnosis = await diagnoseLlmConfig();
      expect(diagnosis.summary).toContain("LLM_API_KEY contains characters");
      expect(JSON.stringify(diagnosis)).not.toContain("synthetic");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected Figma fetch errors with argument and configured secrets", async () => {
    fetchMock.mockRejectedValue(new Error(`Failure ${argumentKey}, ${apiKey}, ${figmaKey}.`));
    const { fetchFileTree } = await import("../src/lib/figmaApi.js");
    const error = await fetchFileTree("SyntheticSecrets", argumentKey).then(() => { throw new Error("Expected failure"); }, (cause: Error) => cause);
    expect(error.message).toContain("api.figma.com");
    for (const secret of [argumentKey, apiKey, figmaKey]) expect(error.message).not.toContain(secret);
  });

  it("keeps SDK debug diagnostics on stderr without the response body", async () => {
    vi.stubEnv("OPENAI_LOG", "debug");
    const stdoutDebug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const stdoutInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    fetchMock.mockImplementation(async () => new Response(`Incorrect API key provided: ${apiKey}`, { status: 401 }));
    const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");
    await diagnoseLlmConfig();
    expectNoSecrets(vi.mocked(console.error).mock.calls);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("LLM SDK: response error, status 401");
    expect(stdoutDebug).not.toHaveBeenCalled();
    expect(stdoutInfo).not.toHaveBeenCalled();
  });

  it("keeps a figmaAccessToken argument out of provider SDK logs within that ingest", async () => {
    vi.stubEnv("OPENAI_LOG", "debug");
    const fixtureFetch = fetchMock.getMockImplementation() as (request: string | URL | Request) => Promise<Response>;
    fetchMock.mockImplementation(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      return url.hostname === "provider.invalid"
        ? new Response(`Incorrect API key provided: ${apiKey}; token ${argumentKey}`, { status: 401 })
        : fixtureFetch(request);
    });
    const { ingestBoard } = await import("../src/tools/ingestBoard.js");
    expectNoSecrets(await ingestBoard({ ...input, figmaAccessToken: argumentKey }));
    expectNoSecrets(vi.mocked(console.error).mock.calls);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("LLM SDK: response error, status 401");
  });

  it("redacts before diagnostic whitespace folding and truncation", async () => {
    const key = "unusual\tkey-extra";
    vi.stubEnv("LLM_API_KEY", "valid-header-key");
    vi.stubEnv("FIGMA_ACCESS_TOKEN", key);
    fetchMock.mockResolvedValue(json({ error: { message: `${"x".repeat(190)} ${key}`, code: "invalid" } }, 401));
    const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");
    const diagnosis = await diagnoseLlmConfig();
    expect(JSON.stringify(diagnosis)).not.toContain("unusual");
  });
});
