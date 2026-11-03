import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const environmentNames = [
  "FIGJAM_MCP_ENV_FILE", "FIGMA_ACCESS_TOKEN", "LLM_BASE_URL", "LLM_API_KEY",
  "FIGJAM_MCP_REDACT_CREDENTIALS", "ENV_FILE_SYNTHETIC_VALUE",
] as const;
const originalArgv = process.argv;
const source = new URL("../src/index.ts", import.meta.url).href;
const redactSource = new URL("../src/lib/redact.ts", import.meta.url).href;
const llmSource = new URL("../src/lib/llmClient.ts", import.meta.url).href;
const tsx = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
let directory: string;
let stderr: MockInstance<typeof console.error>;
let stdout: MockInstance<typeof process.stdout.write>;
let exit: MockInstance<typeof process.exit>;
const fetch = vi.fn(async () => { throw new Error("Unexpected network request"); });

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "figjam-env-"));
  vi.resetModules();
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  process.argv = [...originalArgv, "--version"];
  stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  exit = vi.spyOn(process, "exit").mockImplementation(code => { throw new Error(`Unexpected process.exit(${code})`); });
  fetch.mockClear();
  vi.stubGlobal("fetch", fetch);
});
afterEach(async () => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("node:os");
  await rm(directory, { recursive: true, force: true });
  expect(fetch).not.toHaveBeenCalled();
});

async function loadServer(extra: NodeJS.ProcessEnv = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const name of environmentNames) vi.stubEnv(name, undefined);
  vi.stubEnv("FIGJAM_MCP_CACHE_DIR", path.join(directory, "cache"));
  for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value);
  stderr.mockClear();
  stdout.mockClear();
  exit.mockClear();
  // Exercise the real entrypoint and its dependency graph without starting stdio.
  await expect(import("../src/index.js")).resolves.toBeDefined();
  expect(exit).not.toHaveBeenCalled();
  expect(stdout).toHaveBeenCalledOnce();
  return stderr.mock.calls.map(args => args.join(" ")).join("\n");
}

async function runServer(extra: NodeJS.ProcessEnv = {}) {
  const stderr = await loadServer(extra);
  const { redactCredentials } = await import("../src/lib/redact.js");
  const { missingLlmConfigurationMessage } = await import("../src/lib/llmClient.js");
  return { stderr, data: {
    baseURL: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY,
    redaction: process.env.FIGJAM_MCP_REDACT_CREDENTIALS,
    masked: redactCredentials("API key: should-hide"), configurationMessage: missingLlmConfigurationMessage(),
  } };
}

async function runMissingFigma(extra: NodeJS.ProcessEnv = {}) {
  const stderr = await loadServer(extra);
  const { ingestBoard } = await import("../src/tools/ingestBoard.js");
  let error: string | undefined;
  try {
    await ingestBoard({ figmaFileUrl: "https://www.figma.com/board/EnvFixture123/Synthetic", docStructureHint: "freeform", ingestMode: "max_speed" });
  } catch (cause) { error = (cause as Error).message; }
  return { stderr, data: { error, fetchCalls: fetch.mock.calls.length } };
}

// Keep one real process start to verify that a foreign working-directory .env
// cannot affect startup; all configurable-file and error cases run in process.
function runForeignEnvServer() {
  const env = { ...process.env };
  for (const name of environmentNames) delete env[name];
  return spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "--eval", `
    process.argv.push('--version');
    await import(${JSON.stringify(source)});
    const { redactCredentials } = await import(${JSON.stringify(redactSource)});
    const { missingLlmConfigurationMessage } = await import(${JSON.stringify(llmSource)});
    console.log(JSON.stringify({baseURL: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY,
      redaction: process.env.FIGJAM_MCP_REDACT_CREDENTIALS, masked: redactCredentials('API key: should-hide'), configurationMessage: missingLlmConfigurationMessage()}));
  `], { cwd: directory, env: { ...env, FIGJAM_MCP_CACHE_DIR: path.join(directory, "cache") }, encoding: "utf8", timeout: 15_000 });
}

describe("explicit environment files", () => {
  it.each([
    { value: "", hasEnvFile: false }, { value: "", hasEnvFile: true },
    { value: " \t ", hasEnvFile: false }, { value: " \t ", hasEnvFile: true },
  ])("treats a blank env-file setting as unset (%j)", async ({ value, hasEnvFile }) => {
    if (hasEnvFile) {
      await writeFile(path.join(directory, ".env"), "LLM_API_KEY=unselected-key-478320\n");
    }
    const result = await runServer({ FIGJAM_MCP_ENV_FILE: value });
    const data = result.data;
    expect(result.stderr).toBe("");
    expect(data).toEqual((await runServer()).data);
    expect(data.key).toBeUndefined();
    expect(data.configurationMessage!.includes("no longer loaded since 0.12.0")).toBe(hasEnvFile);
    expect(data.configurationMessage).not.toContain("could not load");
  });

  it("starts in a directory with a foreign .env without adopting any value or disabling redaction", async () => {
    await writeFile(path.join(directory, ".env"), "LLM_BASE_URL=https://attacker.invalid/v1\nLLM_API_KEY=foreign-key-815269\nFIGJAM_MCP_REDACT_CREDENTIALS=false\n");
    const result = runForeignEnvServer();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    expect(data).toEqual({ masked: "API key: [redacted]", configurationMessage: expect.stringContaining("no longer loaded since 0.12.0") });
    expect(result.stderr).not.toContain("attacker.invalid");
    expect(result.stderr).not.toContain("foreign-key-815269");
  });

  it("loads exactly the configured file while inherited values including empty strings win", async () => {
    const filename = path.join(directory, "selected.env");
    await writeFile(path.join(directory, ".env"), "LLM_API_KEY=unselected-key-478320\n");
    await writeFile(filename, "LLM_BASE_URL=https://selected.invalid/v1\nLLM_API_KEY=selected-key-827345\nFIGJAM_MCP_REDACT_CREDENTIALS=false\n");
    const result = await runServer({ FIGJAM_MCP_ENV_FILE: filename, LLM_BASE_URL: "https://client.invalid/v1", FIGJAM_MCP_REDACT_CREDENTIALS: "" });
    expect(result.data).toEqual({ baseURL: "https://client.invalid/v1", key: "selected-key-827345", redaction: "", masked: "API key: [redacted]" });
    expect(result.stderr).toContain(`FIGJAM_MCP_ENV_FILE loaded ${JSON.stringify(filename)}; variables: LLM_API_KEY.`);
    for (const value of ["selected-key-827345", "unselected-key-478320", "https://selected.invalid/v1", "https://client.invalid/v1"]) expect(result.stderr).not.toContain(value);
  });

  it.each(["missing.env", "unreadable-directory"])("keeps startup alive and attaches the load failure for %s", async filename => {
    if (filename === "unreadable-directory") await mkdir(path.join(directory, filename));
    const selected = path.join(directory, filename);
    const result = await runServer({ FIGJAM_MCP_ENV_FILE: selected });
    const data = result.data;
    expect(result.stderr.trim()).toMatch(/^FIGJAM_MCP_ENV_FILE could not load .*: E(?:NOENT|ISDIR)\.$/);
    expect(data.configurationMessage).toContain(` ${result.stderr.trim()}`);
    expect(data.configurationMessage).not.toContain("no longer loaded");
  });

  it("does not emit the migration hint without a working-directory .env", async () => {
    expect((await runServer()).data.configurationMessage).not.toContain("no longer loaded");
  });

  it.each(["absent", "regular file", "directory", "explicit file"])("adds the missing Figma token migration hint only for an unselected .env regular file (%s)", async kind => {
    const extra: NodeJS.ProcessEnv = {};
    if (kind === "directory") await mkdir(path.join(directory, ".env"));
    if (kind === "regular file" || kind === "explicit file") {
      await writeFile(path.join(directory, ".env"), "FIGMA_ACCESS_TOKEN=foreign-token-498172\n");
    }
    if (kind === "explicit file") {
      extra.FIGJAM_MCP_ENV_FILE = path.join(directory, "selected.env");
      await writeFile(extra.FIGJAM_MCP_ENV_FILE, "# No token configured\n");
    }
    const result = await runMissingFigma(extra);
    const data = result.data;
    if (kind === "explicit file") {
      expect(result.stderr).toContain(`FIGJAM_MCP_ENV_FILE loaded ${JSON.stringify(extra.FIGJAM_MCP_ENV_FILE)}; variables: (none).`);
    }
    expect(data.fetchCalls).toBe(0);
    expect(data.error).toContain("set FIGMA_ACCESS_TOKEN");
    expect(data.error!.includes("no longer loaded since 0.12.0")).toBe(kind === "regular file");
    expect(data.error).not.toContain("foreign-token-498172");
  });

  it("includes the explicit env-file load failure in a missing Figma token error before any request", async () => {
    await writeFile(path.join(directory, ".env"), "FIGMA_ACCESS_TOKEN=foreign-token-498172\n");
    const result = await runMissingFigma({ FIGJAM_MCP_ENV_FILE: path.join(directory, "missing.env") });
    const data = result.data;
    expect(result.stderr.trim()).toMatch(/^FIGJAM_MCP_ENV_FILE could not load .*: ENOENT\.$/);
    expect(data.fetchCalls).toBe(0);
    expect(data.error).toContain("set FIGMA_ACCESS_TOKEN");
    expect(data.error).toContain(result.stderr.trim());
    expect(data.error).not.toContain("no longer loaded");
    expect(data.error).not.toContain("foreign-token-498172");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("does not read an unreadable .env when constructing the migration hint", async () => {
    await writeFile(path.join(directory, ".env"), "LLM_API_KEY=unreadable-value-678102\n");
    await chmod(path.join(directory, ".env"), 0);
    expect((await runServer()).data.configurationMessage).toContain("no longer loaded since 0.12.0");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps startup alive when the selected file cannot be read", async () => {
    const selected = path.join(directory, "private.env");
    await writeFile(selected, "LLM_API_KEY=unreadable-value-678102\n");
    await chmod(selected, 0);
    const result = await runServer({ FIGJAM_MCP_ENV_FILE: selected });
    const data = result.data;
    expect(result.stderr).toContain(`FIGJAM_MCP_ENV_FILE could not load ${JSON.stringify(selected)}: EACCES.`);
    expect(data.configurationMessage).toContain(result.stderr.trim());
    expect(data.key).toBeUndefined();
  });

  it("expands only a home marker or its slash prefix", async () => {
    vi.doMock("node:os", () => ({ homedir: () => directory }));
    const { expandHomePath, loadConfiguredEnvFile } = await import("../src/lib/envFile.js");
    expect(expandHomePath("~")).toBe(directory);
    expect(expandHomePath("~/selected.env")).toBe(path.join(directory, "selected.env"));
    expect(expandHomePath("~someone/selected.env")).toBe("~someone/selected.env");
    await writeFile(path.join(directory, "selected.env"), "ENV_FILE_SYNTHETIC_VALUE=loaded\n");
    vi.stubEnv("FIGJAM_MCP_ENV_FILE", "~/selected.env");
    vi.stubEnv("ENV_FILE_SYNTHETIC_VALUE", undefined);
    loadConfiguredEnvFile();
    expect(process.env.ENV_FILE_SYNTHETIC_VALUE).toBe("loaded");
  });
});
