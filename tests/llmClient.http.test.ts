import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real HTTP and the installed SDK exercise error decoding, body deadlines and
// socket cancellation. No provider key, external endpoint or SDK mock is used.
type Request = { model: string; messages?: Array<{ content: string }>; response_format?: { type: string }; provider?: { require_parameters?: boolean }; reasoning_effort?: string; reasoning?: { effort: string } };
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
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) vi.stubEnv(name, undefined);
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(fixtureErrors).toEqual([]);
});

const hintText = "diagnose_llm_config can test the configured model provider.";

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

  it.each([500, 429])("ends a stalled HTTP %i error body at the request deadline", async status => {
    vi.stubEnv("LLM_REQUEST_TIMEOUT_MS", "1000");
    vi.stubEnv("LLM_RATE_LIMIT_RETRIES", "1");
    const closed = deferred();
    const { chatJson } = await localClient((_request, response) => {
      response.once("close", closed.resolve);
      // Headers and a few body bytes, then silence: the SDK reads error bodies without a deadline of its own.
      response.writeHead(status, { "content-type": "application/json", "content-length": "500" });
      response.flushHeaders();
      response.write('{"error":');
    });
    const started = performance.now();
    await expect(chatJson("stalled/model", messages, schemaOptions)).rejects.toMatchObject({ name: "LlmTimeoutError" });
    expect(performance.now() - started).toBeLessThan(2500);
    await closed.promise;
    expect(requests).toHaveLength(1);
  });

  it("gives answer_from_board its timeout message after at most two requests when a router's 429 body stalls", async () => {
    vi.stubEnv("LLM_ANSWER_REQUEST_TIMEOUT_MS", "1000");
    vi.stubEnv("LLM_TEXT_MODELS", "openrouter/free");
    vi.stubEnv("LLM_TEXT_MODEL", "");
    await localClient((_request, response) => {
      response.writeHead(429, { "content-type": "application/json", "content-length": "500" });
      response.flushHeaders();
      response.write('{"error":');
    });
    const { answerFromBoard } = await import("../src/tools/answerFromBoard.js");
    const { setBoard } = await import("../src/lib/cache.js");
    const { evidenceBoard } = await import("./fixtures/retrieval.js");
    const board = evidenceBoard("StalledBody123");
    setBoard(board.boardId, board);
    await expect(answerFromBoard({ boardId: board.boardId, question: "What is required for payment retries?" }))
      .rejects.toThrow(/^LLM request timed out after 1s\..*adjust LLM_ANSWER_REQUEST_TIMEOUT_MS/);
    expect(requests.length).toBeLessThanOrEqual(2);
  });

  it("keeps a caller abort an abort while an error body is stalled", async () => {
    const ready = deferred();
    const controller = new AbortController();
    const reason = new Error("Caller stopped the synthetic request");
    const { chatJson } = await localClient((_request, response) => {
      response.writeHead(500, { "content-type": "application/json", "content-length": "500" });
      response.flushHeaders();
      response.write('{"error":');
      ready.resolve();
    });
    const pending = chatJson("stalled/model", messages, { ...schemaOptions, requestTimeoutMs: 60000, signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    await ready.promise;
    controller.abort(reason);
    await rejected;
  });

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

  it.each([
    { name: "OpenRouter", url: "https://openrouter.ai/api/v1", status: 402, limitSource: "openrouter_credits",
      message: "This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 3400. To increase, visit //example.test/docs "
        + "or billing.example.test/profile with Authorization: Bearer SYNTHETIC_BEARER_43, eyJTWU5USEVUSUM.eyJTWU5USEVUSUM.U1lOVEhFVElD and kid_z9b8.",
      guidance: "Check your OpenRouter account balance and add credits if needed. OpenRouter estimates the request cost before routing, including the requested maximum output tokens up to its per-request cap.",
      tokens: "The provider reports that the request asked for up to 4096 tokens and the balance covers 3400." },
    { name: "another provider with an embedded payment error", url: "https://openrouter.ai.example.invalid/v1", status: 200,
      message: `Synthetic billing restriction ${"x".repeat(210)}`,
      guidance: "Check your account balance and billing settings with the provider, and add credits if needed." },
    { name: "a bare payment error", url: "https://other.invalid/v1", status: 402, message: undefined,
      guidance: "Check your account balance and billing settings with the provider, and add credits if needed." },
  ])("explains a payment error from $name with fixed guidance and no provider text throughout the diagnosis", async ({ url, status, message, limitSource, guidance, tokens }) => {
      for (const name of ["LLM_TEXT_MODELS", "LLM_FAST_TEXT_MODELS", "LLM_VISION_MODELS"]) vi.stubEnv(name, "paid/first,paid/second");
      vi.stubEnv("LLM_TEXT_MODEL", "");
      vi.stubEnv("LLM_VISION_MODEL", "");
      vi.stubEnv("LLM_BASE_URL", url);
      const fetchMock = vi.fn(async () => Response.json({ error: { code: 402, message, metadata: { limit_source: limitSource } } }, { status }));
      vi.stubGlobal("fetch", fetchMock);
      const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");
      const diagnosis = await diagnoseLlmConfig();
      const expected = "LLM request failed (HTTP 402): " + (limitSource ? "" : "the model provider requires payment or more credits for this model. ")
        + guidance + (tokens ? ` ${tokens}` : "");
      expect(diagnosis.ok).toBe(false);
      for (const check of diagnosis.checks) {
        expect(check).toMatchObject({ ok: false, error: `paid/first: ${expected}`,
          attempts: [{ model: "paid/first", ok: false, error: expected }] });
      }
      expect(diagnosis.summary.split("\n").slice(1).join("\n")).toBe(`LLM configuration has 3 checks failing.\n- text_json, fast_text_json, vision_json: paid/first: ${expected}`);
      expect(JSON.stringify(diagnosis)).not.toMatch(/SYNTHETIC_BEARER_43|eyJ|kid_z9b8|example\.test|Synthetic billing/);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it("keeps an echoed prompt and a bearer value from the body and the response headers out of answer_from_board errors and SDK logs", async () => {
    vi.stubEnv("LLM_TEXT_MODELS", "paid/first,paid/second");
    vi.stubEnv("LLM_TEXT_MODEL", "");
    const marker = "SYNTHETIC_PRIVATE_NOTE";
    vi.stubEnv("OPENAI_LOG", "debug");
    await localClient((request, response) => {
      const prompt = request.messages?.at(-1)?.content ?? "";
      expect(prompt).toContain(marker);
      const echo = `Echo ${prompt.match(/SYNTHETIC_PRIVATE_NOTE/)?.[0]} Authorization: Bearer SYNTHETIC_BEARER_43`;
      response.writeHead(402, { "content-type": "text/plain", "x-request-id": echo, "x-synthetic-trace": echo });
      response.end(echo);
    });
    const { answerFromBoard } = await import("../src/tools/answerFromBoard.js");
    const { setBoard } = await import("../src/lib/cache.js");
    const { evidenceBoard, textNode } = await import("./fixtures/retrieval.js");
    const board = evidenceBoard("PaymentError123", [textNode("1:1", `Payment retries require review. ${marker}`)]);
    setBoard(board.boardId, board);
    await expect(answerFromBoard({ boardId: board.boardId, question: "What is required for payment retries?" }))
      .rejects.toMatchObject({ status: 402,
        message: "LLM request failed (HTTP 402): the model provider requires payment or more credits for this model. "
          + "Check your account balance and billing settings with the provider, and add credits if needed." });
    expect(requests.map(request => request.model)).toEqual(["paid/first"]);
    const stderr = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(stderr).not.toMatch(/SYNTHETIC_PRIVATE_NOTE|SYNTHETIC_BEARER_43/);
    expect(stderr).toContain("LLM SDK: request failed, status 402");
  });

  it("logs the fixed SDK route when a percent-encoded key is in the base URL path", async () => {
    const key = "synthetic-key-893571";
    const encoded = key.replace("s", "%73");
    const endpoint = `https://offline.invalid/${encoded}/v1`;
    vi.stubEnv("LLM_API_KEY", key);
    vi.stubEnv("LLM_BASE_URL", endpoint);
    vi.stubEnv("OPENAI_LOG", "debug");
    const fetchMock = vi.fn(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const { chatJson } = await import("../src/lib/llmClient.js");
    await expect(chatJson("synthetic/model", messages, schemaOptions)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`${endpoint}/chat/completions`, expect.anything());
    const stderr = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(stderr).toContain("LLM SDK: sending request, POST /chat/completions");
    expect(stderr).not.toContain(encoded);
  });

  it.each(["37.59", "37PRIVATE"])("omits the token counts for %s in a 60,000-character payment error", async (value) => {
    for (const name of ["LLM_TEXT_MODELS", "LLM_FAST_TEXT_MODELS", "LLM_VISION_MODELS"]) vi.stubEnv(name, "paid/model");
    vi.stubEnv("LLM_BASE_URL", "https://other.invalid/v1");
    const reason = `You requested up to 4096 tokens, but can only afford ${value}`;
    const message = `${reason} `.repeat(Math.ceil(60_000 / (reason.length + 1))).slice(0, 60_000);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: 402, message } }, { status: 402 })));
    const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");
    const start = performance.now();
    const diagnosis = await diagnoseLlmConfig();
    expect(performance.now() - start).toBeLessThan(1500);
    expect(diagnosis.summary).toContain("Check your account balance and billing settings with the provider");
    expect(JSON.stringify(diagnosis)).not.toContain("The provider reports that the request asked for up to");
  });

  it("reads no token counts or other text from a 60,000-character HTTP 402 reason and stays fast", async () => {
    vi.stubEnv("LLM_BASE_URL", "https://other.invalid/v1");
    const nearMiss = "You requested up to 4096 tokens, but can only afford ";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: {
      message: nearMiss.repeat(Math.ceil(60_000 / nearMiss.length)).slice(0, 60_000),
    } }, { status: 402 })));
    const { chatJson } = await import("../src/lib/llmClient.js");
    const onModelFailed = vi.fn();
    const start = performance.now();
    await expect(chatJson("paid/first", messages, { onModelFailed })).rejects.toMatchObject({ status: 402 });
    expect(performance.now() - start).toBeLessThan(1500);
    expect(onModelFailed).toHaveBeenCalledWith("paid/first", "LLM request failed (HTTP 402): the model provider requires payment or more credits for this model. "
      + "Check your account balance and billing settings with the provider, and add credits if needed.");
  }, 20_000);

  it("leads a failed check with its terminal payment error after an earlier candidate fails", async () => {
    for (const name of ["LLM_TEXT_MODELS", "LLM_FAST_TEXT_MODELS", "LLM_VISION_MODELS"]) vi.stubEnv(name, "paid/first,paid/second");
    vi.stubEnv("LLM_TEXT_MODEL", "");
    vi.stubEnv("LLM_VISION_MODEL", "");
    vi.stubEnv("LLM_BASE_URL", "https://other.invalid/v1");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => JSON.parse(String(init.body)).model === "paid/first"
      ? Response.json({ error: { message: "Model unavailable" } }, { status: 503 })
      : Response.json({ error: { message: "Insufficient credits" } }, { status: 402 })));
    const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");
    const result = await diagnoseLlmConfig();
    expect(result.checks[0]?.attempts?.map(attempt => attempt.model)).toEqual(["paid/first", "paid/second"]);
    expect(result.checks[0]?.error).toMatch(/^paid\/second: LLM request failed \(HTTP 402\).*; paid\/first: Model unavailable$/);
    expect(result.summary).toContain("- text_json, fast_text_json, vision_json: paid/second: LLM request failed (HTTP 402)");
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
    expect(diagnosis.checks.map(check => check.error)).toEqual([
      expect.stringContaining("LLM_TEXT_MODELS"), expect.stringContaining("LLM_FAST_TEXT_MODELS"), expect.stringContaining("LLM_VISION_MODELS"),
    ]);
    expect(diagnosis.checks.map(check => check.attempts!.map(attempt => attempt.model))).toEqual([
      ["text/first", "text/second"], ["text/first", "text/second"], ["vision/only"]]);
    // Both text checks moved to the second candidate after the 404.
    expect(requests.map(request => request.model).sort()).toEqual(["text/first", "text/first", "text/second", "text/second", "vision/only"]);
    const board = evidenceBoard("ProviderError123");
    setBoard(board.boardId, board);
    const answer = answerFromBoard({ boardId: board.boardId, question: "What is required for payment retries?" });
    await expect(answer).rejects.toThrow("LLM request failed (HTTP 404): model text/second was not found or has no available endpoint. Check LLM_TEXT_MODELS.");
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

  it.each([
    ["", "text/own"],
    ["fast/own", "fast/own"],
  ])("runs fast_text_json with LLM_FAST_TEXT_MODELS=%j on %s", async (fastModels, expected) => {
    vi.stubEnv("LLM_TEXT_MODELS", "text/own");
    vi.stubEnv("LLM_FAST_TEXT_MODELS", fastModels);
    vi.stubEnv("LLM_VISION_MODELS", "vision/own");
    vi.stubEnv("LLM_TEXT_MODEL", "");
    vi.stubEnv("LLM_VISION_MODEL", "");
    await localClient((request, response) => {
      const prompt = JSON.stringify((request as Request & { messages: unknown }).messages);
      const content = prompt.includes("17 + 25") ? '{"result":42}' : prompt.includes("9 * 7") ? '{"result":63}' : '{"dominantColor":"blue"}';
      json(response, 200, { id: "local-fixture", object: "chat.completion", created: 1, model: "local-model",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    });
    const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");
    const diagnosis = await diagnoseLlmConfig();
    expect(diagnosis.fastTextModels).toEqual([expected]);
    expect(diagnosis.checks[1]).toMatchObject({ name: "fast_text_json", ok: true, modelUsed: expected });
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

  describe("provider failure messages", () => {
    const hint = "diagnose_llm_config can test the configured model provider.";
    const textReply = (response: ServerResponse, status: number, body: string, type = "text/html") => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    };
    const freePort = async () => {
      const probe = createServer();
      await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
      const { port } = probe.address() as AddressInfo;
      await new Promise<void>(resolve => probe.close(() => resolve()));
      return port;
    };

    it.each([
      [401, "LLM request failed (HTTP 401): the model provider rejected LLM_API_KEY. "
        + `Check the key in your MCP client configuration and restart the server. ${hint}`],
      [403, "LLM request failed (HTTP 403): the model provider denies access to the model or rejects the request, "
        + `for example because of moderation. Check the API key's permissions and the configured models. ${hint}`],
    ])("tells what to do after HTTP %i without provider text", async (status, message) => {
      const { chatJson } = await localClient((_request, response) => json(response, status,
        { error: { code: status, message: "synthetic provider detail", metadata: { raw: "raw provider body" } } }));
      const pending = chatJson(["first/model", "second/model"], messages, schemaOptions);
      await expect(pending).rejects.toMatchObject({ status, message });
      await expect(pending).rejects.not.toThrow(/synthetic provider detail|raw provider body/);
      // Another model does not help against a rejected key or a denied account.
      expect(requests).toHaveLength(1);
    });

    it.each([
      ["without a scheme", "localhost:11434/v1"],
      ["without a host", "/v1"],
      ["with another scheme", "ftp://api.example.com/v1"],
      ["ending in /chat/completions", "https://openrouter.ai/api/v1/chat/completions"],
      ["ending in /chat/completions/", "https://api.example.com/v1/chat/completions/?private=value"],
    ])("rejects an LLM_BASE_URL %s before any request, without printing it", async (_case, value) => {
      vi.stubEnv("LLM_BASE_URL", value);
      const { chatJson, validateLlmConfiguration } = await import("../src/lib/llmClient.js");
      const expected = "LLM_BASE_URL must be an absolute http or https URL of the API root, without /chat/completions, "
        + 'for example https://openrouter.ai/api/v1. Fix it in "env" of this server in your MCP client configuration, then restart the server.';
      expect(() => validateLlmConfiguration()).toThrow(expect.objectContaining({ name: "LLMConfigurationError", message: expected }));
      await expect(chatJson("any/model", messages, schemaOptions)).rejects.toMatchObject({ name: "LLMConfigurationError", message: expected });
      expect(requests).toHaveLength(0);
    });

    it.each([
      ["a refused connection", "http", "connection refused"],
      ["a TLS handshake with a plain HTTP server", "https", "TLS error"],
    ])("names the origin and the cause when %s", async (_case, scheme, cause) => {
      const { chatJson } = await localClient((_request, response) => success(response));
      const port = (server!.address() as AddressInfo).port;
      if (scheme === "http") {
        // The port of a closed server refuses connections.
        const closed = await freePort();
        vi.stubEnv("LLM_BASE_URL", `http://127.0.0.1:${closed}/v1/private-path?private=query`);
      } else vi.stubEnv("LLM_BASE_URL", `https://127.0.0.1:${port}/v1/private-path?private=query`);
      const onModelFailed = vi.fn();
      const pending = chatJson(["first/model", "second/model"], messages, { ...schemaOptions, onModelFailed });
      const origin = new URL(process.env.LLM_BASE_URL!).origin;
      await expect(pending).rejects.toMatchObject({ name: "LlmBaseUrlError",
        message: expect.stringContaining(`could not connect to ${origin} (${cause}`) });
      await expect(pending).rejects.toThrow(`Check LLM_BASE_URL and your network connection. ${hint}`);
      await expect(pending).rejects.not.toThrow(/private-path|private=query/);
      // Both candidates share the URL, so the second is not tried; diagnose_llm_config omits its own name.
      expect(onModelFailed).toHaveBeenCalledOnce();
      expect(onModelFailed.mock.calls[0]?.[1]).not.toContain("diagnose_llm_config");
    });

    it.each([
      [404, "<html><body>Not Found</body></html>", "text/html"],
      [405, "Method Not Allowed", "text/plain"],
      [404, "", "text/plain"],
      [404, '{"detail":"Not Found"}', "application/json"],
      [404, "{}", "application/json"],
    ])("reports a wrong path after one request for HTTP %i without an error message (%s)", async (status, body, type) => {
      const { chatJson } = await localClient((_request, response) => textReply(response, status, body, type));
      const pending = chatJson(["openrouter/free", "second/model"], messages, schemaOptions);
      await expect(pending).rejects.toMatchObject({ name: "LlmBaseUrlError", status, message:
        `LLM request failed (HTTP ${status}): the answer held no error message, so LLM_BASE_URL probably points to a wrong path. `
        + `OpenAI-compatible APIs usually end in /v1, for example https://openrouter.ai/api/v1. Check LLM_BASE_URL. ${hint}` });
      // No router repetition, no format fallback and no other candidate: they all use the same URL.
      expect(requests).toHaveLength(1);
    });

    it.each([
      ["an error object (OpenAI, OpenRouter)", { error: { code: 404, message: "No endpoints found for missing/model." } }],
      ["a message at the top level (vLLM)", { object: "error", message: "The model `missing/model` does not exist.", type: "NotFoundError", param: null, code: 404 }],
    ])("keeps a 404 with %s a missing-model failure", async (_case, missing) => {
      const { chatJson } = await localClient((request, response) => request.model === "missing/model"
        ? json(response, 404, missing) : success(response));
      await expect(chatJson(["missing/model", "available/model"], messages, schemaOptions)).resolves.toEqual({ ok: true });
      expect(requests.map(request => request.model)).toEqual(["missing/model", "available/model"]);
    });

    describe("HTTP 429", () => {
      const midnight = Date.parse("2026-11-06T00:00:00Z");
      const limited = (response: ServerResponse, headers: Record<string, string> = {}, body: unknown = { error: { code: 429, message: "Rate limit exceeded" } }) => {
        response.writeHead(429, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(body));
      };

      it("waits for a short Retry-After and repeats the request once", async () => {
        vi.stubEnv("LLM_RATE_LIMIT_RETRIES", "1");
        const { chatJson } = await localClient((_request, response) => requests.length === 1 ? limited(response, { "retry-after": "1" }) : success(response));
        const started = performance.now();
        await expect(chatJson("limited/model", messages, schemaOptions)).resolves.toEqual({ ok: true });
        expect(performance.now() - started).toBeGreaterThanOrEqual(900);
        expect(requests).toHaveLength(2);
      });

      it.each([
        ["seconds", () => "3600", 3600],
        ["an HTTP date", () => new Date(Date.now() + 3_600_000).toUTCString(), 3600],
      ])("fails at once when Retry-After (%s) exceeds the longest backoff, and names the time in UTC", async (_case, header, seconds) => {
        vi.stubEnv("LLM_RATE_LIMIT_RETRIES", "1");
        const { chatJson } = await localClient((_request, response) => limited(response, { "retry-after": header() }));
        const started = performance.now();
        const failure = await chatJson(["openrouter/free", "second/model"], messages, schemaOptions).catch((error: unknown) => error) as Error & { status: number; retryAfter: number };
        expect(performance.now() - started).toBeLessThan(1500);
        expect(failure).toMatchObject({ status: 429 });
        expect(Math.abs(failure.retryAfter - seconds)).toBeLessThanOrEqual(2);
        expect(failure.message).toMatch(/^LLM request failed \(HTTP 429\): the model provider's request limit is reached; it accepts requests again at about \d{4}-\d\d-\d\d \d\d:\d\d UTC\. Wait, or use another model or API key\. diagnose_llm_config can/);
        // A rate limit is not repeated at a router, but the second candidate is tried once.
        expect(requests.map(request => request.model)).toEqual(["openrouter/free", "second/model"]);
      });

      it.each([
        ["response headers", "response"],
        ["error.metadata.headers", "metadata"],
        ["a 200 response body", "body"],
      ])("reads the daily limit from X-RateLimit-Reset in %s and names midnight UTC", async (_case, location) => {
        vi.stubEnv("LLM_RATE_LIMIT_RETRIES", "1");
        let clock = Date.parse("2026-11-05T23:59:00Z");
        vi.spyOn(Date, "now").mockImplementation(() => clock++);
        const { chatJson } = await localClient((_request, response) => {
          const headers = { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(midnight) };
          if (location === "response") limited(response, headers);
          else if (location === "metadata") limited(response, {}, { error: { code: 429, message: "Rate limit exceeded", metadata: { headers } } });
          else json(response, 200, { error: { code: 429, message: "Rate limit exceeded", metadata: { headers } } });
        });
        const failure = await chatJson("limited/model", messages, schemaOptions).catch((error: unknown) => error) as Error & { retryAfter: number; retryAt: number };
        expect(requests).toHaveLength(1);
        expect(failure).toMatchObject({ status: 429, retryAt: midnight });
        expect(failure.retryAfter).toBeGreaterThanOrEqual(59);
        expect(failure.retryAfter).toBeLessThanOrEqual(60);
        expect(failure.message).toContain("it accepts requests again at about 2026-11-06 00:00 UTC");
      });

      it("ignores X-RateLimit-Reset while requests remain and keeps the usual backoff", async () => {
        vi.stubEnv("LLM_RATE_LIMIT_RETRIES", "1");
        vi.stubEnv("LLM_RATE_LIMIT_MAX_BACKOFF_MS", "0");
        let clock = midnight - 60_000;
        vi.spyOn(Date, "now").mockImplementation(() => clock++);
        const { chatJson } = await localClient((_request, response) => requests.length === 1
          ? limited(response, { "x-ratelimit-remaining": "3", "x-ratelimit-reset": String(midnight) }) : success(response));
        await expect(chatJson("limited/model", messages, schemaOptions)).resolves.toEqual({ ok: true });
        expect(requests).toHaveLength(2);
      });

      it("does not wait for a retry that no longer fits into the total deadline", async () => {
        vi.stubEnv("LLM_RATE_LIMIT_RETRIES", "1");
        const { chatJson } = await localClient((_request, response) => limited(response, { "retry-after": "3" }));
        const started = performance.now();
        await expect(chatJson("limited/model", messages, { ...schemaOptions, totalTimeoutMs: 3500 })).rejects.toMatchObject({ status: 429, retryAfter: 3 });
        expect(performance.now() - started).toBeLessThan(1500);
        expect(requests).toHaveLength(1);
      });
    });
  });

  describe("replies the model or provider cannot use", () => {
    const completion = (message: Record<string, unknown>, finish = "stop") => ({ id: "local-fixture", object: "chat.completion", created: 1,
      model: "local-model", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }] });

    it.each([
      ["empty text", completion({ content: "" }), "empty", "returned an empty response (no text)"],
      ["null content", completion({ content: null }), "empty", "returned an empty response (no text)"],
      ["a refusal", completion({ content: null, refusal: "synthetic private refusal text" }), "refusal", "declined to answer (refusal)"],
      ["the content filter", completion({ content: null }, "content_filter"), "content_filter", "had its reply blocked by the provider's content filter"],
      ["the output limit", completion({ content: "" }, "length"), "length", "ran into max_tokens before any text arrived"],
      ["only reasoning", completion({ content: "", reasoning: "synthetic private reasoning" }), "reasoning", "returned only reasoning and no text"],
      ["no choices", { id: "x", object: "chat.completion" }, "no_choices", "returned a reply with no choices"],
      ["empty choices", { choices: [] }, "no_choices", "returned a reply with no choices"],
      ["a tool call", completion({ content: null, tool_calls: [{ id: "call", type: "function", function: { name: "lookup", arguments: "{}" } }] }, "tool_calls"),
        "tool_call", "returned a tool call instead of text"],
    ])("names the cause of a reply with %s", async (_case, reply, reason, text) => {
      const { chatJson } = await localClient((_request, response) => json(response, 200, reply));
      const pending = chatJson(["only/model"], messages, { ...schemaOptions, outputSetting: "LLM_ANSWER_MAX_OUTPUT_TOKENS" });
      await expect(pending).rejects.toMatchObject({ name: "LlmEmptyReplyError", reason, message: expect.stringContaining(`LLM (only/model) ${text}`) });
      await expect(pending).rejects.not.toThrow(/synthetic private/);
      if (reason === "length") await expect(pending).rejects.toThrow("Raise LLM_ANSWER_MAX_OUTPUT_TOKENS");
    });

    it.each([
      ["a refusal", completion({ content: null, refusal: "no" })],
      ["no choices", { id: "x", object: "chat.completion" }],
    ])("tries the next candidate and repeats a router request once after %s, as before", async (_case, reply) => {
      const { chatJson } = await localClient((request, response) => request.model === "good/model" ? success(response)
        : json(response, 200, reply));
      await expect(chatJson(["openrouter/free", "good/model"], messages, schemaOptions)).resolves.toEqual({ ok: true });
      expect(requests.map(request => request.model)).toEqual(["openrouter/free", "openrouter/free", "good/model"]);
    });

    it.each([
      ["an empty body", (response: ServerResponse) => { response.writeHead(200, { "content-type": "application/json" }); response.end(); }, "the response body was empty", 1],
      ["an empty body without content type", (response: ServerResponse) => { response.writeHead(200); response.end(); }, "the response body was empty", 1],
      ["an HTML page", (response: ServerResponse) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<html>Login</html>"); }, "the response was not JSON", 1],
      ["broken JSON", (response: ServerResponse) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"choices": [{'); }, "the response body was not valid JSON", 1],
      ["HTML with a JSON content type", (response: ServerResponse) => { response.writeHead(200, { "content-type": "application/json" }); response.end("<html>Login</html>"); }, "the response body was not valid JSON", 1],
      ["a JSON array", (response: ServerResponse) => json(response, 200, []), "the response was not a JSON object", 1],
      ["JSON null", (response: ServerResponse) => { response.writeHead(200, { "content-type": "application/json" }); response.end("null"); }, "the response body was empty", 1],
      ["a body cut off by the server", (response: ServerResponse) => {
        response.writeHead(200, { "content-type": "application/json", "content-length": "500" }); response.write('{"choices":'); setTimeout(() => response.destroy(), 20);
      }, "the response body was cut off", 1],
    ])("says LLM_BASE_URL returned no chat completion for %s, without a raw error", async (_case, reply, detail, expectedRequests) => {
      const { chatJson } = await localClient((_request, response) => reply(response));
      const pending = chatJson(["first/model", "second/model"], messages, schemaOptions);
      await expect(pending).rejects.toMatchObject({ name: "LlmBaseUrlError", message: "LLM request failed: LLM_BASE_URL did not return a chat completion "
        + `(${detail}). Check that it points to an OpenAI-compatible API, for example https://openrouter.ai/api/v1. diagnose_llm_config can test the configured model provider.` });
      // A body that is no JSON object says the URL is wrong for every model, so no other candidate is tried.
      expect(requests).toHaveLength(expectedRequests);
    });
  });

  describe("response format", () => {
    const formats = () => requests.map(request => request.response_format?.type ?? "none");
    const rejectFormats = (rejected: string[], message = "response_format json_schema is not supported") => (request: Request, response: ServerResponse) => {
      if (rejected.includes(request.response_format?.type ?? "none")) json(response, 400, { error: { code: 400, message } });
      else success(response);
    };

    it.each([
      [400, "json: cannot unmarshal object into Go struct field .response_format of type string"],
      [422, "Invalid schema for response_format 'figjam': In context=(), 'additionalProperties' is required to be supplied and to be false."],
    ])("falls back to json_object after HTTP %i that names the response format without a word like unsupported", async (status, message) => {
      const { chatJson } = await localClient((request, response) => request.response_format?.type === "json_schema"
        ? json(response, status, { error: { code: status, message } }) : success(response));
      await expect(chatJson("ollama/model", messages, schemaOptions)).resolves.toEqual({ ok: true });
      expect(formats()).toEqual(["json_schema", "json_object"]);
    });

    it("does not fall back after a 400 about payment or policy that mentions the format", async () => {
      const { chatJson } = await localClient((_request, response) => json(response, 400, { error: { code: 400,
        message: "Blocked by content policy; the response_format was valid." } }));
      await expect(chatJson("policy/model", messages, schemaOptions)).rejects.toMatchObject({ status: 400 });
      expect(formats()).toEqual(["json_schema"]);
    });

    it.each([
      ["without json_schema", ["json_schema"], [3, ["json_schema", "json_object", "json_object"]]],
      ["without any format", ["json_schema", "json_object"], [4, ["json_schema", "json_object", "none", "none"]]],
    ] as const)("remembers the working format of a fixed model for a provider %s", async (_case, rejected, [count, expected]) => {
      const { chatJson } = await localClient(rejectFormats([...rejected]));
      await chatJson("fixed/model", messages, schemaOptions);
      await chatJson("fixed/model", messages, schemaOptions);
      expect(requests).toHaveLength(count);
      expect(formats()).toEqual(expected);
      // Another model of the same provider starts from the best format again.
      await chatJson("other/model", messages, schemaOptions);
      expect(formats()[count]).toBe("json_schema");
    });

    it.each(["openrouter/free", "openrouter/auto"])("does not remember a format for the router %s", async router => {
      const { chatJson } = await localClient(rejectFormats(["json_schema"]));
      await chatJson(router, messages, schemaOptions);
      await chatJson(router, messages, schemaOptions);
      expect(formats()).toEqual(["json_schema", "json_object", "json_schema", "json_object"]);
    });
  });

  describe("reasoning setting", () => {
    const reasoningRejected = (status: number) => (request: Request, response: ServerResponse) => request.reasoning_effort !== undefined
      ? json(response, status, { error: { code: status, message: "Unrecognized request argument supplied: reasoning_effort" } }) : success(response);

    it.each([400, 422])("names LLM_ANSWER_REASONING_EFFORT when HTTP %i rejects the setting, without a format fallback", async status => {
      vi.stubEnv("LLM_ANSWER_REASONING_EFFORT", "low");
      vi.stubEnv("LLM_TEXT_MODELS", "text/own");
      vi.stubEnv("LLM_TEXT_MODEL", "");
      await localClient(reasoningRejected(status));
      const { answerFromBoard } = await import("../src/tools/answerFromBoard.js");
      const { setBoard } = await import("../src/lib/cache.js");
      const { evidenceBoard } = await import("./fixtures/retrieval.js");
      const board = evidenceBoard(`Reasoning${status}`);
      setBoard(board.boardId, board);
      await expect(answerFromBoard({ boardId: board.boardId, question: "What is required for payment retries?" })).rejects.toMatchObject({ status,
        message: `LLM request failed (HTTP ${status}): the model provider rejected the reasoning setting. `
          + `Unset LLM_ANSWER_REASONING_EFFORT, choose another value or another model. ${hintText}` });
      expect(requests).toHaveLength(1);
    });

    it("sends the answer reasoning setting with the text check of diagnose_llm_config and finds a provider that rejects it", async () => {
      vi.stubEnv("LLM_ANSWER_REASONING_EFFORT", "low");
      vi.stubEnv("LLM_TEXT_MODELS", "text/own");
      vi.stubEnv("LLM_FAST_TEXT_MODELS", "fast/own");
      vi.stubEnv("LLM_VISION_MODELS", "vision/own");
      vi.stubEnv("LLM_TEXT_MODEL", "");
      vi.stubEnv("LLM_VISION_MODEL", "");
      await localClient((request, response) => {
        const prompt = JSON.stringify((request as Request & { messages: unknown }).messages);
        if (request.reasoning_effort !== undefined) return json(response, 400, { error: { code: 400, message: "Unrecognized request argument supplied: reasoning_effort" } });
        const content = prompt.includes("17 + 25") ? '{"result":42}' : prompt.includes("9 * 7") ? '{"result":63}' : '{"dominantColor":"blue"}';
        json(response, 200, { id: "local-fixture", object: "chat.completion", created: 1, model: "local-model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
      });
      const { diagnoseLlmConfig } = await import("../src/tools/diagnoseLlmConfig.js");
      const diagnosis = await diagnoseLlmConfig();
      expect(diagnosis.checks.map(check => [check.name, check.ok])).toEqual([["text_json", false], ["fast_text_json", true], ["vision_json", true]]);
      expect(diagnosis.checks[0]?.error).toBe("text/own: Unrecognized request argument supplied: reasoning_effort, code 400");
      expect(requests.filter(request => request.reasoning_effort !== undefined).map(request => request.model)).toEqual(["text/own"]);
    });
  });
});
