import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { retrieveEvidence } from "../src/lib/evidence.js";
import { answerGroundingFixtures } from "./fixtures/answerGrounding.js";

const execute = promisify(execFile);

describe("retrieval evaluation CLI", () => {
  it("requires explicit provider opt-in for grounding-only evaluation", async () => {
    await expect(execute(process.execPath, ["--import", "tsx", "scripts/evaluate-retrieval.mjs", "--grounding-only"]))
      .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("--with-llm [--grounding-only]") });
  });

  it("makes all status records available for each semantic acceptance question", () => {
    for (const fixture of answerGroundingFixtures) {
      const sources = retrieveEvidence(fixture.board, { query: fixture.query, limit: 6 });
      expect(new Set(sources.evidence.map((item) => item.nodeId))).toEqual(new Set(fixture.board.nodes.map((node) => node.id)));
    }
  });

  it("stays offline by default even when provider settings exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figjam-eval-"));
    try {
      const guard = join(directory, "offline.mjs");
      await writeFile(guard, 'globalThis.fetch = () => { throw new Error("Unexpected network attempt"); };');
      const { stdout } = await execute(process.execPath, ["--import", "tsx", "--import", pathToFileURL(guard).href, "scripts/evaluate-retrieval.mjs"], {
        env: { ...process.env, LLM_BASE_URL: "https://synthetic-eval.invalid/v1", LLM_API_KEY: "synthetic-key" },
      });
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({ mode: "offline", fixtures: 20, recallAt1: 1, correctAbstentionRate: 1, apiCalls: 0 });
      expect(result.baselineProxy).toMatchObject({ historicalBenchmark: false, visibleFacts: 15, totalFacts: 18 });
      expect(result.revisions).toMatchObject({ fixtures: 20, passed: 20 });
      expect(result.external).toBeUndefined();
      expect(result.semanticGrounding).toMatchObject({ fixtures: 5, generation: "not measured (offline; no provider calls)", semanticReview: "required" });
      expect(result.semanticGrounding.cases).toHaveLength(5);
      for (const item of result.semanticGrounding.cases) {
        expect(item).toMatchObject({ semanticReview: "required", generation: "not measured (offline; no provider call)" });
        expect(item.question).toBeTruthy();
        expect(item.expectedBehavior).toBeTruthy();
        expect(item.sources.length).toBeGreaterThan(0);
        expect(item.answer).toBeUndefined();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("measures attempts and reported usage with explicit opt-in, including format fallback and missing usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figjam-eval-"));
    try {
      const provider = join(directory, "synthetic-provider.mjs");
      await writeFile(provider, `
        let calls = 0;
        globalThis.fetch = async (url, options) => {
          if (String(url) !== "https://synthetic-eval.invalid/v1/chat/completions") throw new Error("Unexpected endpoint");
          const request = JSON.parse(options.body);
          calls++;
          if (calls === 1) return new Response(JSON.stringify({ error: { message: "Unsupported response format" } }), { status: 400, headers: { "content-type": "application/json" } });
          const context = request.messages.find(message => message.role === "user").content;
          const id = context.match(/\\[(ev_[a-f0-9]+)\\]/)[1];
          return new Response(JSON.stringify({ id: "completion", object: "chat.completion", created: 1, model: request.model,
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ answer: calls > 19 ? "Nein, der Simulator ist nicht gebucht." : "Source excerpt.", evidenceIds: [id] }) } }],
            ...(calls === 19 ? {} : { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
          }), { headers: { "content-type": "application/json" } });
        };
      `);
      const { stdout } = await execute(process.execPath, ["--import", "tsx", "--import", pathToFileURL(provider).href, "scripts/evaluate-retrieval.mjs", "--with-llm"], {
        env: { ...process.env, LLM_BASE_URL: "https://synthetic-eval.invalid/v1", LLM_API_KEY: "synthetic-key", LLM_TEXT_MODELS: "synthetic-model", LLM_TEXT_MODEL: "", LLM_MODEL_PRESET: "student-free" },
      });
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({ mode: "explicit-provider-evaluation", fixtures: 20, apiCalls: 24 });
      expect(result.providerEvaluation).toEqual({ selection: "retrieval-and-grounding", selectedFixtures: 25, perCaseTimeoutMs: 45000 });
      expect(result.external).toMatchObject({ completedFixtures: 20, failedFixtures: 0, structuralCitationValidity: 1, expectedSourceRecall: 1, correctAbstentionRate: 1, sdkRetries: 0 });
      expect(result.tokenUsage).toMatchObject({ receivedCompletions: 23, totalTokens: { reportedSum: 2640, reportedCompletions: 22, missingCompletions: 1 } });
      expect(result.externalCases.filter((item: { expectedNodeId: string | null }) => !item.expectedNodeId).every((item: { httpAttempts: number }) => item.httpAttempts === 0)).toBe(true);
      expect(result.semanticGrounding).toMatchObject({ fixtures: 5, generation: "responses collected for human review", semanticReview: "required" });
      expect(result.semanticGrounding.cases.map((item: { expectedStatus: string }) => item.expectedStatus)).toEqual(["unknown", "confirmed", "denied", "unknown", "conflicting"]);
      for (const item of result.semanticGrounding.cases) {
        // Deliberately incorrect synthetic answers still require review even with valid source IDs.
        expect(item).toMatchObject({ answer: "Nein, der Simulator ist nicht gebucht.", httpAttempts: 1,
          citationCount: 1, validCitationCount: 1, semanticReview: "required" });
        expect(item).not.toHaveProperty("passed");
        expect(item).not.toHaveProperty("abstained");
        expect(item).not.toHaveProperty("citesExpectedNode");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restricts provider calls to the five grounding cases while retaining offline retrieval and revision checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figjam-eval-"));
    try {
      const provider = join(directory, "grounding-provider.mjs");
      await writeFile(provider, `
        let calls = 0;
        globalThis.fetch = async (url, options) => {
          if (String(url) !== "https://synthetic-eval.invalid/v1/chat/completions") throw new Error("Unexpected endpoint");
          const request = JSON.parse(options.body);
          const context = request.messages.find(message => message.role === "user").content;
          if (!context.includes("Question: Ist der Simulator") || ++calls > 5) throw new Error("Unexpected provider case");
          const ids = [...context.matchAll(/\\[(ev_[a-f0-9]+)\\]/g)].map(match => match[1]);
          return new Response(JSON.stringify({ id: "completion", object: "chat.completion", created: 1, model: request.model,
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ answer: "Synthetic answer requiring review.", evidenceIds: ids }) } }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }), { headers: { "content-type": "application/json" } });
        };
      `);
      const { stdout } = await execute(process.execPath, ["--import", "tsx", "--import", pathToFileURL(provider).href, "scripts/evaluate-retrieval.mjs", "--with-llm", "--grounding-only"], {
        env: { ...process.env, LLM_BASE_URL: "https://synthetic-eval.invalid/v1", LLM_API_KEY: "synthetic-key", LLM_TEXT_MODELS: "synthetic-model", LLM_TEXT_MODEL: "", LLM_MODEL_PRESET: "student-free" },
      });
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({ mode: "explicit-provider-evaluation", fixtures: 20, recallAt1: 1, correctAbstentionRate: 1, apiCalls: 5 });
      expect(result.providerEvaluation).toEqual({ selection: "grounding-only", selectedFixtures: 5, perCaseTimeoutMs: 45000 });
      expect(result.revisions).toMatchObject({ fixtures: 20, passed: 20 });
      expect(result.external).toBeUndefined();
      expect(result.externalCases).toBeUndefined();
      expect(result.tokenUsage).toMatchObject({ receivedCompletions: 5, totalTokens: { reportedSum: 600, reportedCompletions: 5, missingCompletions: 0 } });
      expect(result.semanticGrounding.cases).toHaveLength(5);
      for (const item of result.semanticGrounding.cases) {
        expect(item).toMatchObject({ httpAttempts: 1, attemptedModels: ["synthetic-model"], semanticReview: "required" });
        expect(item).not.toHaveProperty("passed");
        expect(item).not.toHaveProperty("error");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("aborts timed-out cases without model fallbacks and reports only a safe timeout category", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figjam-eval-"));
    try {
      const provider = join(directory, "timeout-provider.mjs");
      await writeFile(provider, `
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        AbortSignal.timeout = ms => {
          if (ms !== 45000) throw new Error("Unexpected case deadline");
          return timeout(100);
        };
        globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
          const pending = setTimeout(() => reject(new Error("Uncancelled request")), 10000);
          const aborted = () => { clearTimeout(pending); reject(new Error("PRIVATE_PROVIDER_ERROR")); };
          if (options.signal.aborted) aborted();
          else options.signal.addEventListener("abort", aborted, { once: true });
        });
      `);
      let failure: { code?: number; stdout?: string; stderr?: string } | undefined;
      try {
        await execute(process.execPath, ["--import", "tsx", "--import", pathToFileURL(provider).href, "scripts/evaluate-retrieval.mjs", "--with-llm", "--grounding-only"], {
          env: { ...process.env, LLM_BASE_URL: "https://synthetic-eval.invalid/v1", LLM_API_KEY: "synthetic-key", LLM_TEXT_MODELS: "synthetic-model,unexpected-fallback", LLM_TEXT_MODEL: "", LLM_MODEL_PRESET: "student-free" },
        });
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure?.code).toBe(1);
      expect(failure?.stdout).not.toContain("PRIVATE_PROVIDER_ERROR");
      expect(failure?.stderr).not.toContain("PRIVATE_PROVIDER_ERROR");
      const result = JSON.parse(failure!.stdout!);
      expect(result).toMatchObject({ apiCalls: 5, tokenUsage: { receivedCompletions: 0 } });
      expect(result.semanticGrounding.cases).toHaveLength(5);
      for (const item of result.semanticGrounding.cases) {
        expect(item).toMatchObject({ error: "EvaluationTimeoutError", httpAttempts: 1, attemptedModels: ["synthetic-model"], semanticReview: "required" });
        expect(item).not.toHaveProperty("answer");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
