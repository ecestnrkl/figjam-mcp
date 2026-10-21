import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real HTTP and the installed SDK exercise error decoding, body deadlines and
// socket cancellation. No provider key, external endpoint or SDK mock is used.
type Request = { model: string; response_format?: { type: string }; provider?: { require_parameters?: boolean }; reasoning_effort?: string; reasoning?: { effort: string } };
const messages = [{ role: "user" as const, content: "Synthetic fixture only" }];
const schemaOptions = { jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } } };
let server: Server | undefined;
let requests: Request[];
let fixtureErrors: unknown[];

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function success(response: ServerResponse) {
  json(response, 200, { id: "local-fixture", object: "chat.completion", created: 1, model: "local-model",
    choices: [{ index: 0, message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

async function localClient(handle: (request: Request, response: ServerResponse) => void | Promise<void>) {
  server = createServer(async (request, response) => {
    try {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer local-fixture-key");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
      requests.push(body);
      await handle(body, response);
    } catch (error) {
      fixtureErrors.push(error);
      response.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  vi.stubEnv("LLM_BASE_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  return await import("../src/lib/llmClient.js");
}

beforeEach(() => {
  vi.resetModules();
  requests = [];
  fixtureErrors = [];
  vi.stubEnv("LLM_API_KEY", "local-fixture-key");
  vi.stubEnv("LLM_REQUEST_TIMEOUT_MS", "2000");
  vi.stubEnv("LLM_SDK_MAX_RETRIES", "0");
  vi.stubEnv("LLM_RATE_LIMIT_RETRIES", "0");
  vi.stubEnv("LLM_PROVIDER_REQUIRE_PARAMETERS", "true");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (server?.listening) {
    const closing = new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closing;
  }
  server = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  expect(fixtureErrors).toEqual([]);
});

describe("LLM requests through real local HTTP and the OpenAI SDK", () => {
  it("serializes opt-in reasoning for a generic compatible endpoint without changing later requests", async () => {
    const { chatJson } = await localClient((_request, response) => success(response));
    await chatJson("answer-model", messages, { ...schemaOptions, reasoningEffort: "low" });
    await chatJson("vision-model", messages, schemaOptions);
    expect(requests.map(request => [request.reasoning_effort, request.reasoning])).toEqual([["low", undefined], [undefined, undefined]]);
  });

  it("keeps explicit reasoning after format rejection but does not retry ambiguous parameter failures", async () => {
    const { chatJson } = await localClient((request, response) => {
      if (request.model === "ambiguous/model") {
        json(response, 404, { error: { code: 404, message: "No endpoints found that support the requested parameters." } });
      } else if (request.response_format?.type === "json_schema") {
        json(response, 400, { error: { code: 400, message: "json_schema response format is not supported" } });
      } else success(response);
    });
    await expect(chatJson("available/model", messages, { ...schemaOptions, reasoningEffort: "none" })).resolves.toEqual({ ok: true });
    await expect(chatJson("ambiguous/model", messages, { ...schemaOptions, reasoningEffort: "none" })).rejects.toMatchObject({ status: 404 });
    expect(requests.map(request => [request.model, request.response_format?.type, request.reasoning_effort]))
      .toEqual([["available/model", "json_schema", "none"], ["available/model", "json_object", "none"], ["ambiguous/model", "json_schema", "none"]]);
  });

  it("distinguishes missing-model 404s from format-routing 404s and preserves each fallback", async () => {
    const { chatJson, getLlmClient } = await localClient((request, response) => {
      if (request.model === "missing/model") {
        json(response, 404, { error: { code: 404, message: "No endpoints found for missing/model." } });
      } else if (request.response_format?.type === "json_schema") {
        json(response, 404, { error: { code: 404,
          message: "No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection",
          metadata: { failed_routing_step: "Filter by Parameters" } } });
      } else if (request.response_format) {
        json(response, 400, { error: { code: 400, message: "Provider returned error", metadata: {
          raw: JSON.stringify({ code: 400, reason: "INVALID_REQUEST_BODY", message: "Model 'available/model' does not support 'json_object' response format.", metadata: {} }),
        } } });
      } else success(response);
    });
    expect(getLlmClient().maxRetries).toBe(0);
    const onRequest = vi.fn();
    await expect(chatJson(["missing/model", "available/model"], messages, { ...schemaOptions, onRequest }))
      .resolves.toEqual({ ok: true });
    expect(requests.map(request => [request.model, request.response_format?.type]))
      .toEqual([
        ["missing/model", "json_schema"],
        ["available/model", "json_schema"],
        ["available/model", "json_object"],
        ["available/model", undefined],
      ]);
    // OpenRouter's provider field never reaches another host.
    expect(requests.every(request => request.provider === undefined)).toBe(true);
    expect(onRequest.mock.calls.map(([model]) => model)).toEqual(requests.map(request => request.model));
  });

  it("enforces the original request deadline when 200 headers arrive before a stalled body", async () => {
    const closed = deferred();
    let headersSent = false;
    const { chatJson } = await localClient(async (_request, response) => {
      response.once("close", closed.resolve);
      // If the SDK reset the deadline after headers, this would take >=3.25s.
      await new Promise(resolve => setTimeout(resolve, 1250));
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write('{"choices":');
      headersSent = true;
    });
    const onUsage = vi.fn();
    const started = performance.now();
    await expect(chatJson("stalled/model", messages, { ...schemaOptions, onUsage }))
      .rejects.toMatchObject({ name: "LlmTimeoutError" });
    const elapsed = performance.now() - started;
    expect(headersSent).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(1800);
    expect(elapsed).toBeLessThan(3000);
    await closed.promise;
    expect(requests).toHaveLength(1);
    expect(onUsage).not.toHaveBeenCalled();
  }, 10_000);

  it("moves to the next configured model after a body timeout without SDK retries or format retries", async () => {
    vi.stubEnv("LLM_REQUEST_TIMEOUT_MS", "1000");
    const closed = deferred();
    const { chatJson } = await localClient((request, response) => {
      if (request.model === "stalled/model") {
        response.once("close", closed.resolve);
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
      } else success(response);
    });
    const onUsage = vi.fn();
    await expect(chatJson(["stalled/model", "available/model"], messages, { ...schemaOptions, onUsage }))
      .resolves.toEqual({ ok: true });
    await closed.promise;
    expect(requests.map(request => [request.model, request.response_format?.type]))
      .toEqual([["stalled/model", "json_schema"], ["available/model", "json_schema"]]);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: "available/model", totalTokens: 2 }));
  });

  it("allows a longer request override through body completion and keeps the next text deadline unchanged", async () => {
    vi.stubEnv("LLM_REQUEST_TIMEOUT_MS", "1000");
    const closed = deferred();
    const { chatJson } = await localClient(async (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      if (request.model === "longer/vision") {
        await new Promise(resolve => setTimeout(resolve, 1250));
        response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }));
      } else response.once("close", closed.resolve);
    });
    await expect(chatJson("longer/vision", messages, { ...schemaOptions, requestTimeoutMs: 2500 }))
      .resolves.toEqual({ ok: true });
    const started = performance.now();
    await expect(chatJson("ordinary/text", messages, schemaOptions))
      .rejects.toThrow("LLM request timed out after 1s.");
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    expect(performance.now() - started).toBeLessThan(2000);
    await closed.promise;
    expect(requests.map(request => request.model)).toEqual(["longer/vision", "ordinary/text"]);
  });

  it("names the provider's message in diagnose_llm_config only, without metadata.raw", async () => {
    const raw = "raw provider body that must stay hidden";
    for (const [name, value] of [["LLM_TEXT_MODELS", "text/first,text/second"], ["LLM_FAST_TEXT_MODELS", "text/first,text/second"],
      ["LLM_VISION_MODELS", "vision/only"], ["LLM_TEXT_MODEL", ""], ["LLM_VISION_MODEL", ""]]) vi.stubEnv(name!, value!);
    await localClient((_request, response) => json(response, 404, { error: { code: 404,
      message: `Provider returned error: ${"synthetic detail ".repeat(20)}`, metadata: { provider_name: "SyntheticProvider", raw } } }));
    const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");
    const { answerFromBoard } = await import("../src/tools/answerFromBoard.js");
    const { setBoard } = await import("../src/lib/cache.js");
    const { evidenceBoard } = await import("./fixtures/retrieval.js");
    const diagnosis = await diagnoseLlmConfig();
    expect(diagnosis.checks.map(check => check.ok)).toEqual([false, false, false]);
    for (const check of diagnosis.checks) {
      expect(check.attempts!.map(attempt => attempt.ok)).toEqual(check.attempts!.map(() => false));
      for (const attempt of check.attempts!) {
        expect(attempt.error).toMatch(/^Provider returned error: (synthetic detail )+/);
        expect(attempt.error!.length).toBeLessThanOrEqual(200);
        expect(check.error).toContain(`${attempt.model}: ${attempt.error}`);
      }
      expect(check.error).not.toContain(raw);
    }
    expect(diagnosis.checks.map(check => check.attempts!.map(attempt => attempt.model))).toEqual([
      ["text/first", "text/second"], ["text/first", "text/second"], ["vision/only"]]);
    // Both text checks moved to the second candidate after the 404.
    expect(requests.map(request => request.model).sort()).toEqual(["text/first", "text/first", "text/second", "text/second", "vision/only"]);
    const board = evidenceBoard("ProviderError123");
    setBoard(board.boardId, board);
    const answer = answerFromBoard({ boardId: board.boardId, question: "What is required for payment retries?" });
    await expect(answer).rejects.toThrow("LLM request failed (HTTP 404). Check provider availability and configuration.");
    await expect(answer).rejects.not.toThrow(/Provider returned error|SyntheticProvider|synthetic detail|raw provider body/);
  });

  describe("router retry", () => {
    const providerError = (response: ServerResponse) => json(response, 404, { error: { code: 404,
      message: "Provider returned error", metadata: { provider_name: "Nvidia" } } });

    it("repeats a failed openrouter/free request once and returns its reply", async () => {
      const { chatJson } = await localClient((_request, response) => requests.length === 1 ? providerError(response) : success(response));
      const failed: string[] = [];
      await expect(chatJson(["openrouter/free"], messages, { ...schemaOptions, onModelFailed: model => failed.push(model) }))
        .resolves.toEqual({ ok: true });
      expect(requests.map(request => request.model)).toEqual(["openrouter/free", "openrouter/free"]);
      expect(failed).toEqual(["openrouter/free"]);
    });

    it.each([
      [["openrouter/free"], ["openrouter/free", "openrouter/free"]],
      [["openrouter/auto", "next/model"], ["openrouter/auto", "openrouter/auto", "next/model"]],
    ])("fails %j after exactly two router requests, then tries the next candidate", async (models, expected) => {
      const { chatJson } = await localClient((request, response) => request.model.startsWith("openrouter/") ? providerError(response) : success(response));
      const result = chatJson(models, messages, schemaOptions);
      if (models.length === 1) await expect(result).rejects.toThrow("LLM request failed (HTTP 404)");
      else await expect(result).resolves.toEqual({ ok: true });
      expect(requests.map(request => request.model)).toEqual(expected);
    });

    it("does not repeat other models or rate-limited router requests", async () => {
      let status = 404;
      const { chatJson } = await localClient((_request, response) => status === 429
        ? json(response, 429, { error: { code: 429, message: "Rate limit exceeded" } }) : providerError(response));
      await expect(chatJson(["plain/model"], messages, schemaOptions)).rejects.toThrow("HTTP 404");
      expect(requests).toHaveLength(1);
      status = 429;
      await expect(chatJson(["openrouter/free"], messages, schemaOptions)).rejects.toThrow("HTTP 429");
      expect(requests).toHaveLength(2);
    });

    it("does not repeat a router request without enough time left or after cancellation", async () => {
      const controller = new AbortController();
      const { chatJson } = await localClient(async (_request, response) => {
        await new Promise(resolve => setTimeout(resolve, requests.length === 1 ? 700 : 50));
        if (requests.length === 2) controller.abort(new Error("Caller stopped the synthetic request"));
        providerError(response);
      });
      // 1,500 ms in total leave less than MIN_REQUEST_TIMEOUT_MS after a 700 ms first request.
      await expect(chatJson(["openrouter/free", "unused/model"], messages, { ...schemaOptions, totalTimeoutMs: 1500 }))
        .rejects.toThrow("HTTP 404");
      expect(requests).toHaveLength(1);
      await expect(chatJson(["openrouter/free"], messages, { ...schemaOptions, signal: controller.signal }))
        .rejects.toThrow("Caller stopped the synthetic request");
      expect(requests).toHaveLength(2);
    });

    it("lists both router attempts in diagnose_llm_config and names the retry", async () => {
      for (const name of ["LLM_TEXT_MODELS", "LLM_FAST_TEXT_MODELS", "LLM_VISION_MODELS"]) vi.stubEnv(name, "openrouter/free");
      vi.stubEnv("LLM_TEXT_MODEL", "");
      vi.stubEnv("LLM_VISION_MODEL", "");
      let textRequests = 0;
      await localClient((request, response) => {
        const prompt = JSON.stringify((request as Request & { messages: unknown }).messages);
        const content = prompt.includes("17 + 25") ? '{"result":42}' : prompt.includes("9 * 7") ? '{"result":63}' : '{"dominantColor":"blue"}';
        if (prompt.includes("17 + 25") && ++textRequests === 1) return providerError(response);
        json(response, 200, { id: "local-fixture", object: "chat.completion", created: 1, model: "local-model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
      });
      const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");
      const diagnosis = await diagnoseLlmConfig();
      expect(diagnosis.ok).toBe(true);
      expect(diagnosis.checks[0]?.attempts).toEqual([
        { model: "openrouter/free", ok: false, error: expect.stringContaining("Provider returned error") },
        { model: "openrouter/free", ok: true },
      ]);
      expect(diagnosis.checks[0]?.attempts?.[0]?.error).toContain("Nvidia");
      expect(diagnosis.summary).toContain("Retry: text_json passed on the second openrouter/free attempt.");
      expect(diagnosis.summary).not.toContain("Fallback");
      expect(requests).toHaveLength(4);
    });
  });

  it("cancels a stalled response body and preserves the caller reason without trying another model", async () => {
    const ready = deferred();
    const closed = deferred();
    const { chatJson } = await localClient((_request, response) => {
      response.once("close", closed.resolve);
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write('{"choices":');
      ready.resolve();
    });
    const controller = new AbortController();
    const reason = new Error("Caller stopped the synthetic request");
    const pending = chatJson(["stalled/model", "unused/model"], messages, { ...schemaOptions, requestTimeoutMs: 60000, signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    await ready.promise;
    controller.abort(reason);
    await rejected;
    await closed.promise;
    expect(requests).toHaveLength(1);
  });
});
