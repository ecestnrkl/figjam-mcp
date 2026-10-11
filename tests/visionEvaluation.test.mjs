import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadVisionFixtures } from "../scripts/evaluate-vision.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/evaluate-vision.mjs", import.meta.url));
const fixtureDirectory = new URL("./fixtures/vision/", import.meta.url);
const providerEnv = {
  ...process.env,
  LLM_BASE_URL: "https://synthetic-vision.invalid/v1", LLM_API_KEY: "synthetic-vision-key",
  LLM_VISION_MODELS: "synthetic-vision", LLM_VISION_MODEL: "", LLM_MODEL_PRESET: "student-free",
  LLM_REQUEST_TIMEOUT_MS: "20000", LLM_VISION_MAX_OUTPUT_TOKENS: "4096",
  LLM_RATE_LIMIT_RETRIES: "0", LLM_PROVIDER_REQUIRE_PARAMETERS: "true",
};

async function runWithProvider(source) {
  const directory = await mkdtemp(join(tmpdir(), "figjam-vision-eval-"));
  try {
    const provider = join(directory, "provider.mjs");
    await writeFile(provider, source);
    try {
      const result = await execute(process.execPath, ["--import", "tsx", "--import", pathToFileURL(provider).href, script, "--with-llm"], { env: providerEnv });
      return { code: 0, ...result };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const mockProvider = `
  import assert from 'node:assert/strict';
  import { createHash } from 'node:crypto';
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://synthetic-vision.invalid/v1/chat/completions');
    const request = JSON.parse(options.body);
    const user = request.messages.find(message => message.role === 'user');
    const text = request.messages.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.filter(part => part.type === 'text').map(part => part.text)).join('\\n');
    for (const forbidden of ['8400', '8.400', 'EUR', 'Vorschlag', 'zusätzliche', 'Parkplatz', 'requiredFacts', 'forbiddenClaims', 'vision-01', 'vision-02', 'fixture-01', 'fixture-02', 'manifest.json']) assert(!text.includes(forbidden), 'Fixture expectation leaked into prompt: ' + forbidden);
    assert(text.includes('Internal connections (untrusted data):\\n[]'));
    const images = user.content.filter(part => part.type === 'image_url');
    assert.equal(images.length, 1);
    const bytes = Buffer.from(images[0].image_url.url.split(',')[1], 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const ids = {
      '8b1f862d49fa05b0759cb159e23ee460279b6596660a4afd29b770543a9ac86d': '1:1',
      'f7c926d62b58ca4144d5d60be3bcd7012d774641dbfcb12499d2b444ae77b938': '2:1',
    };
    const id = ids[hash];
    assert(id, 'Unexpected image pixels');
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'Unsupported response format' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    const reply = { label: 'Synthetic response', summary: 'Synthetic summary. Needs review. No semantic pass.', confirmedNodeIds: [id] };
    return new Response(JSON.stringify({ id: 'synthetic-completion', object: 'chat.completion', created: 1, model: 'actual-vision-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply) } }],
      ...(calls === 3 ? {} : { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0 } }),
    }), { headers: { 'content-type': 'application/json' } });
  };
`;

describe("vision evaluation CLI", () => {
  it("requires explicit opt-in and explicit provider configuration", async () => {
    await expect(execute(process.execPath, [script, "--unknown"]))
      .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("--with-llm") });
    await expect(execute(process.execPath, [script, "--with-llm"], {
      env: { ...providerEnv, LLM_API_KEY: "" },
    })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("explicit LLM_BASE_URL and LLM_API_KEY") });
  });

  it("stays offline even with provider settings and locates fixtures independently of cwd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figjam-vision-offline-"));
    try {
      const guard = join(directory, "offline.mjs");
      await writeFile(guard, 'globalThis.fetch = () => { throw new Error("Unexpected network"); };');
      const { stdout } = await execute(process.execPath, ["--import", pathToFileURL(guard).href, script], { cwd: directory, env: providerEnv });
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({ mode: "offline", fixtures: 2, apiCalls: 0, semanticReview: "required" });
      expect(result.providerEvaluation).toBeUndefined();
      for (const item of result.cases) {
        expect(item).toMatchObject({ integrity: "verified", semanticReview: "required", generation: "not measured (offline; no provider call)" });
        expect(item).not.toHaveProperty("output");
        expect(item).not.toHaveProperty("passed");
      }
      expect(stdout).not.toContain(providerEnv.LLM_API_KEY);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps portable image-only inputs separate from expectations and rejects changed pixels", async () => {
    const fixtures = await loadVisionFixtures();
    const manifest = await readFile(new URL("manifest.json", fixtureDirectory), "utf8");
    expect(manifest).not.toMatch(/\/Users\/|\/System\/|[A-Z]:\\\\/);
    for (const fixture of fixtures) {
      expect(fixture.nodes.every(node => !node.text && !node.table)).toBe(true);
      expect(fixture.connections).toEqual([]);
      expect(createHash("sha256").update(fixture.screenshots[0]).digest("hex")).toBe(fixture.image.sha256);
    }
    const directory = await mkdtemp(join(tmpdir(), "figjam-vision-integrity-"));
    try {
      await cp(fixtureDirectory, directory, { recursive: true });
      const image = join(directory, "fixture-01.png");
      const bytes = await readFile(image);
      bytes[bytes.length - 1] ^= 1;
      await writeFile(image, bytes);
      await expect(loadVisionFixtures(pathToFileURL(directory + "/"))).rejects.toThrow("Fixture image checksum changed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses production vision prompts without expected facts and records raw model identity, attempts and missing usage", async () => {
    const execution = await runWithProvider(mockProvider);
    expect(execution.code, execution.stderr).toBe(0);
    const result = JSON.parse(execution.stdout);
    expect(result).toMatchObject({ mode: "explicit-provider-evaluation", fixtures: 2, apiCalls: 3, semanticReview: "required" });
    expect(result.providerEvaluation).toMatchObject({ models: ["synthetic-vision"], sdkRetries: 0, perCaseTimeoutMs: 45000, maxOutputTokens: 4096 });
    expect(result.tokenUsage).toMatchObject({ receivedCompletions: 2,
      totalTokens: { reportedSum: 120, reportedCompletions: 1, missingCompletions: 1 } });
    expect(result.cases[0].attempts.map(attempt => attempt.httpStatus)).toEqual([400, 200]);
    expect(result.cases[0].attempts.map(attempt => attempt.responseFormat)).toEqual(["json_schema", "json_object"]);
    for (const item of result.cases) {
      expect(item.structuralIssues).toEqual([]);
      expect(item.output).toMatchObject({ summarySource: "vision_llm", modelId: "synthetic-vision" });
      const response = item.attempts.at(-1);
      expect(response).toMatchObject({ responseComplete: true, completion: { actualModel: "actual-vision-model", rawIdValidation: "passed" } });
      expect(JSON.parse(response.completion.rawContent)).toEqual(response.completion.rawJson);
      expect(response.completion.rawConfirmedNodeIds).toEqual(item.expected.requiredConfirmedNodeIds);
      expect(item).not.toHaveProperty("passed");
      expect(item).not.toHaveProperty("semanticPass");
    }
  });

  it("retains invented raw IDs when the production function rejects the refinement", async () => {
    const execution = await runWithProvider(mockProvider.replace("confirmedNodeIds: [id]", "confirmedNodeIds: [id, 'invented-node', 42]"));
    expect(execution.code, execution.stderr).toBe(1);
    const result = JSON.parse(execution.stdout);
    for (const item of result.cases) {
      expect(item.output).toBeUndefined();
      expect(item.error).toBe("LlmInvalidJsonError");
      expect(item.attempts.at(-1).completion).toMatchObject({ rawIdValidation: "failed", invalidConfirmedNodeIds: ["invented-node", 42] });
      expect(item.structuralIssues).toContain("Raw confirmedNodeIds is missing or contains invalid IDs");
    }
  });

  it("aborts a stalled response body at the case deadline and never claims a completion", async () => {
    const execution = await runWithProvider(`
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = ms => { if (ms !== 45000) throw new Error('Unexpected deadline'); return timeout(100); };
      globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":[')); },
      }), { headers: { 'content-type': 'application/json' } });
    `);
    expect(execution.code, execution.stderr).toBe(1);
    const result = JSON.parse(execution.stdout);
    expect(result).toMatchObject({ apiCalls: 2, tokenUsage: { receivedCompletions: 0 } });
    for (const item of result.cases) {
      expect(item).toMatchObject({ error: "EvaluationTimeoutError", httpAttempts: 1 });
      expect(item.attempts[0]).toMatchObject({ httpStatus: 200, responseComplete: false });
      expect(item.attempts[0].completion).toBeUndefined();
      expect(item.output).toBeUndefined();
    }
  });
});
