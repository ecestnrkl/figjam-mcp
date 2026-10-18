/** npm run eval:vision [-- --with-llm]. Offline by default; synthetic images only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const defaultFixtures = new URL("../tests/fixtures/vision/", import.meta.url);
const perCaseTimeoutMs = 75_000;
const maxObservedBytes = 1024 * 1024;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

/** Check the committed pixels and keep evaluation answers separate from product input. */
export async function loadVisionFixtures(directory = defaultFixtures) {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
  assert.equal(manifest.schemaVersion, 1, "Unsupported vision fixture schema");
  assert.equal(manifest.fixtures?.length, 2, "Expected two synthetic vision fixtures");
  assert.equal(new Set(manifest.fixtures.map(fixture => fixture.id)).size, 2, "Duplicate fixture IDs");
  const loaded = [];
  for (const fixture of manifest.fixtures) {
    const { image, nodes, cluster, connections, expected } = fixture;
    assert.equal(image.file, basename(image.file), "Fixture image must use a portable filename");
    assert.match(image.file, /^fixture-[0-9]+\.png$/);
    assert.equal(image.mimeType, "image/png");
    assert.equal(nodes.length, 1, "Each image is one neutral source node");
    assert.equal(nodes[0].type, "RECTANGLE");
    assert.match(nodes[0].name, /^Bild [12]$/);
    assert(!nodes[0].text && !nodes[0].table, "Image-only fixtures cannot supply extracted facts");
    assert(nodes[0].imageRef, "Fixture must identify an image node");
    assert.deepEqual(connections, [], "Image-only arrows cannot be supplied as graph evidence");
    assert.deepEqual(cluster.nodeIds, nodes.map(node => node.id));
    assert.deepEqual(expected.requiredConfirmedNodeIds, cluster.nodeIds);
    assert.equal(expected.reviewRequired, true);
    assert(expected.requiredFacts.length > 0 && expected.forbiddenClaims.length > 0);
    const bytes = await readFile(new URL(image.file, directory));
    assert.equal(bytes.length, image.bytes, "Fixture image byte count changed");
    assert.equal(digest(bytes), image.sha256, "Fixture image checksum changed");
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Expected PNG pixels");
    assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
    assert.equal(bytes.readUInt32BE(16), image.width, "Fixture width changed");
    assert.equal(bytes.readUInt32BE(20), image.height, "Fixture height changed");
    assert.equal(nodes[0].width, image.width);
    assert.equal(nodes[0].height, image.height);
    loaded.push({ ...fixture, screenshots: [bytes] });
  }
  return loaded;
}

function rawJson(content) {
  if (typeof content !== "string") return undefined;
  try { return JSON.parse(content); } catch { /* Keep raw text for independent review. */ }
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(stripped); } catch { /* The product can also extract an embedded object. */ }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  try { return start >= 0 && end > start ? JSON.parse(stripped.slice(start, end + 1)) : undefined; }
  catch { return undefined; }
}

function recordCompletion(attempt, body) {
  let envelope;
  try { envelope = JSON.parse(body); } catch { attempt.responseJsonValid = false; return; }
  attempt.responseJsonValid = true;
  if (!Array.isArray(envelope?.choices) || !envelope.choices.length) return;
  const choice = envelope.choices[0];
  attempt.completion = {
    actualModel: typeof envelope.model === "string" ? envelope.model : null,
    finishReason: choice.finish_reason ?? null,
    rawContent: typeof choice.message?.content === "string" ? choice.message.content : null,
    rawJson: rawJson(choice.message?.content) ?? null,
    usage: {
      promptTokens: numberOrNull(envelope.usage?.prompt_tokens),
      completionTokens: numberOrNull(envelope.usage?.completion_tokens),
      totalTokens: numberOrNull(envelope.usage?.total_tokens),
      reasoningTokens: numberOrNull(envelope.usage?.completion_tokens_details?.reasoning_tokens),
      providerReportedCost: numberOrNull(envelope.usage?.cost),
    },
  };
}
const numberOrNull = value => Number.isFinite(value) ? value : null;

/** Observe only bytes consumed by the SDK; do not start a second body reader. */
function observeResponse(response, attempt, start, signal) {
  let finished = false;
  const finish = state => {
    if (finished) return;
    finished = true;
    attempt.bodyState = state;
    attempt.responseComplete = state === "complete";
    attempt.elapsedMs = roundMs(performance.now() - start);
    signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => finish("aborted");
  if (!response.body) { finish("absent"); return response; }
  attempt.bodyState = "reading";
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const chunks = [];
  let bytes = 0;
  const observer = new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes <= maxObservedBytes) chunks.push(Buffer.from(chunk));
      else { attempt.captureTruncated = true; chunks.length = 0; }
      controller.enqueue(chunk);
    },
    flush() {
      finish("complete");
      if (attempt.responseComplete && !attempt.captureTruncated && response.ok) recordCompletion(attempt, Buffer.concat(chunks).toString("utf8"));
    },
  });
  // Observe pipeline settlement without consuming the body a second time. A
  // rejected source or cancelled reader does not run TransformStream.flush().
  void response.body.pipeTo(observer.writable, signal ? { signal } : undefined)
    .catch(() => finish(signal?.aborted ? "aborted" : "interrupted"));
  return new Response(observer.readable, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

function observedFetch(originalFetch, observation) {
  return async (input, init) => {
    const { attempts, signal } = observation.current;
    const request = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const attemptStart = performance.now();
    const attempt = {
      requestedModel: request.model ?? null,
      responseFormat: request.response_format?.type ?? "none",
      maxOutputTokens: request.max_tokens ?? null,
      temperature: request.temperature ?? null,
      requestSha256: digest(JSON.stringify(request)),
      responseComplete: false,
      bodyState: "awaiting_headers",
    };
    attempts.push(attempt);
    try {
      const response = await originalFetch(input, init);
      attempt.httpStatus = response.status;
      attempt.headersMs = roundMs(performance.now() - attemptStart);
      return observeResponse(response, attempt, attemptStart, init?.signal ? AbortSignal.any([signal, init.signal]) : signal);
    } catch (cause) {
      attempt.elapsedMs = roundMs(performance.now() - attemptStart);
      attempt.bodyState = signal.aborted || init?.signal?.aborted ? "aborted" : "fetch_failed";
      // The product still receives its original error; no provider error body is recorded.
      throw cause;
    }
  };
}

async function evaluateFixture(fixture, refineClusterWithVision, observation) {
  const attempts = [];
  const signal = AbortSignal.timeout(perCaseTimeoutMs);
  const start = performance.now();
  observation.current = { attempts, signal };
  let output;
  let error;
  try {
    // Never pass expected values, fixture IDs or filenames to the production function.
    output = await refineClusterWithVision(structuredClone(fixture.cluster), fixture.screenshots,
      structuredClone(fixture.nodes), signal, structuredClone(fixture.connections));
  } catch (cause) {
    error = signal.aborted ? "EvaluationTimeoutError" : cause instanceof Error ? cause.name : "UnknownError";
  } finally {
    observation.current = undefined;
  }
  const completions = attempts.flatMap(attempt => attempt.completion ? [attempt.completion] : []);
  for (const completion of completions) {
    const ids = completion.rawJson?.confirmedNodeIds;
    completion.rawConfirmedNodeIds = Array.isArray(ids) ? ids : null;
    completion.invalidConfirmedNodeIds = Array.isArray(ids)
      ? ids.filter(id => typeof id !== "string" || !fixture.cluster.nodeIds.includes(id)) : [];
    completion.rawIdValidation = !Array.isArray(ids) ? "unavailable"
      : completion.invalidConfirmedNodeIds.length ? "failed" : "passed";
  }
  const rawReply = completions.at(-1);
  const structuralIssues = [];
  if (rawReply && rawReply.rawIdValidation !== "passed") {
    structuralIssues.push("Raw confirmedNodeIds is missing or contains invalid IDs");
  }
  if (output) {
    if (!rawReply?.rawJson) structuralIssues.push("Raw model JSON was not captured");
    if (fixture.expected.requiredConfirmedNodeIds.some(id => !rawReply?.rawConfirmedNodeIds?.includes(id))) {
      structuralIssues.push("Raw model JSON omits a required source node");
    }
    if (output.summarySource !== fixture.expected.requiredSummarySource) structuralIssues.push("Unexpected summary provenance");
    if (fixture.expected.requiredConfirmedNodeIds.some(id => !output.confirmedNodeIds.includes(id))) {
      structuralIssues.push("Applied refinement omits a required source node");
    }
  }
  return {
    id: fixture.id, image: fixture.image, expected: fixture.expected, semanticReview: "required",
    elapsedMs: roundMs(performance.now() - start), httpAttempts: attempts.length,
    attemptedModels: attempts.map(attempt => attempt.requestedModel), attempts, structuralIssues,
    ...(output ? { output, formatting: {
      labelWords: output.label.trim().split(/\s+/u).length,
      summarySentencesHeuristic: output.summary.match(/[^.!?]+(?:[.!?]+|$)/gu)?.length ?? 0,
      note: "Formatting counts are descriptive heuristics, not semantic acceptance.",
    } } : {}),
    ...(error ? { error } : {}),
  };
}
const roundMs = value => Number(value.toFixed(3));

function aggregateUsage(cases) {
  const attempts = cases.flatMap(item => item.attempts ?? []);
  const completions = attempts.flatMap(attempt => attempt.completion ? [attempt.completion] : []);
  return {
    httpAttempts: attempts.length,
    receivedCompletions: completions.length,
    ...Object.fromEntries(["promptTokens", "completionTokens", "totalTokens", "reasoningTokens", "providerReportedCost"].map(field => {
      const reported = completions.filter(item => Number.isFinite(item.usage[field]));
      return [field, { reportedSum: reported.reduce((sum, item) => sum + item.usage[field], 0),
        reportedCompletions: reported.length, missingCompletions: completions.length - reported.length,
        missingAttempts: attempts.length - reported.length }];
    })),
    note: "Only provider-reported usage is summed. Reasoning tokens are included in completion tokens. Missing attempt usage and costs are unknown, not zero; currency costs are not independently measured.",
  };
}

export async function main(flags = process.argv.slice(2)) {
  if (flags.some(flag => flag !== "--with-llm") || flags.length > 1) {
    console.error("Usage: npm run eval:vision [-- --with-llm]");
    return 2;
  }
  const withLlm = flags.includes("--with-llm");
  if (withLlm && (!process.env.LLM_BASE_URL?.trim() || !process.env.LLM_API_KEY?.trim())) {
    console.error("--with-llm requires explicit LLM_BASE_URL and LLM_API_KEY. Only synthetic PNG fixtures are sent; configured providers may charge for calls.");
    return 2;
  }
  const fixtures = await loadVisionFixtures();
  let providerEvaluation;
  let refine;
  if (withLlm) {
    process.env.LLM_SDK_MAX_RETRIES = "0";
    const { getModelConfig } = await import("../src/lib/modelRegistry.ts");
    const { readIntEnv } = await import("../src/lib/env.ts");
    const { getVisionRequestTimeoutMs } = await import("../src/lib/llmTimeouts.ts");
    providerEvaluation = {
      providerOrigin: new URL(process.env.LLM_BASE_URL).origin,
      models: getModelConfig().visionModels, providerRequireParameters: getModelConfig().providerRequireParameters,
      perCaseTimeoutMs, requestTimeoutMs: getVisionRequestTimeoutMs(),
      maxOutputTokens: readIntEnv("LLM_VISION_MAX_OUTPUT_TOKENS", 4096, 256),
      rateLimitRetries: readIntEnv("LLM_RATE_LIMIT_RETRIES", 1, 0),
      rateLimitMaxBackoffMs: readIntEnv("LLM_RATE_LIMIT_MAX_BACKOFF_MS", 5000, 0), sdkRetries: 0,
    };
    refine = (await import("../src/lib/visionInterpreter.ts")).refineClusterWithVision;
  }
  const cases = [];
  const observation = {};
  const originalFetch = globalThis.fetch;
  // The SDK retains its fetch function when creating a client. Keep one observer
  // for the whole run, and change only the active fixture recording context.
  if (withLlm) globalThis.fetch = observedFetch(originalFetch, observation);
  try {
    for (const fixture of fixtures) cases.push(withLlm ? await evaluateFixture(fixture, refine, observation) : {
      id: fixture.id, image: fixture.image, expected: fixture.expected,
      integrity: "verified", semanticReview: "required", generation: "not measured (offline; no provider call)",
    });
  } finally {
    if (withLlm) globalThis.fetch = originalFetch;
  }
  const result = {
    evaluation: "Two synthetic image-only fixtures; not a real-board or general vision benchmark",
    mode: withLlm ? "explicit-provider-evaluation" : "offline", fixtures: fixtures.length,
    ...(providerEvaluation ? { providerEvaluation } : {}),
    apiCalls: cases.reduce((sum, item) => sum + (item.httpAttempts ?? 0), 0),
    tokenUsage: withLlm ? aggregateUsage(cases) : "not measured (no provider calls)",
    semanticReview: "required",
    note: "No automatic semantic pass. Compare raw JSON and applied output with required facts and forbidden claims; valid IDs and successful generation do not establish correctness.",
    cases,
  };
  // Synthetic response text is retained, but accidental echoes of the configured key never are.
  const serialized = JSON.stringify(result, null, 2);
  const key = process.env.LLM_API_KEY?.trim();
  console.log(key ? serialized.split(key).join("[REDACTED_API_KEY]") : serialized);
  return cases.some(item => item.error || item.structuralIssues?.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(); }
  catch (error) {
    console.error(`Vision evaluation failed (${error instanceof Error ? error.name : "UnknownError"}); verify fixture integrity and explicit provider settings.`);
    process.exitCode = 1;
  }
}
