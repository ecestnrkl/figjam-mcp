import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real HTTP and the installed SDK exercise error decoding, body deadlines and
// socket cancellation. No provider key, external endpoint or SDK mock is used.
type Request = { model: string; response_format?: { type: string }; provider?: { require_parameters?: boolean } };
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
    expect(requests.map(request => [request.model, request.response_format?.type, request.provider?.require_parameters]))
      .toEqual([
        ["missing/model", "json_schema", true],
        ["available/model", "json_schema", true],
        ["available/model", "json_object", true],
        ["available/model", undefined, undefined],
      ]);
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
    const pending = chatJson(["stalled/model", "unused/model"], messages, { ...schemaOptions, signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    await ready.promise;
    controller.abort(reason);
    await rejected;
    await closed.promise;
    expect(requests).toHaveLength(1);
  });
});
