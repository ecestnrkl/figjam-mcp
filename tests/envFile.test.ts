import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const original = { ...process.env };
const source = new URL("../src/index.ts", import.meta.url).href;
const redactSource = new URL("../src/lib/redact.ts", import.meta.url).href;
const llmSource = new URL("../src/lib/llmClient.ts", import.meta.url).href;
const ingestSource = new URL("../src/tools/ingestBoard.ts", import.meta.url).href;
const tsx = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "figjam-env-"));
  vi.resetModules();
});
afterEach(async () => {
  process.env = { ...original };
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function runServer(extra: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const name of ["FIGJAM_MCP_ENV_FILE", "FIGMA_ACCESS_TOKEN", "LLM_BASE_URL", "LLM_API_KEY", "FIGJAM_MCP_REDACT_CREDENTIALS"]) delete env[name];
  return spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "--eval", `
    process.argv.push('--version');
    await import(${JSON.stringify(source)});
    const { redactCredentials } = await import(${JSON.stringify(redactSource)});
    const { missingLlmConfigurationMessage } = await import(${JSON.stringify(llmSource)});
    console.log(JSON.stringify({baseURL: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY,
      redaction: process.env.FIGJAM_MCP_REDACT_CREDENTIALS, masked: redactCredentials('API key: should-hide'), configurationMessage: missingLlmConfigurationMessage()}));
  `], { cwd: directory, env: { ...env, ...extra }, encoding: "utf8", timeout: 15_000 });
}

function runMissingFigma(extra: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const name of ["FIGJAM_MCP_ENV_FILE", "FIGMA_ACCESS_TOKEN", "LLM_BASE_URL", "LLM_API_KEY", "FIGJAM_MCP_REDACT_CREDENTIALS"]) delete env[name];
  return spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "--eval", `
    process.argv.push('--version');
    await import(${JSON.stringify(source)});
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error('Unexpected network request'); };
    const { ingestBoard } = await import(${JSON.stringify(ingestSource)});
    let error;
    try { await ingestBoard({figmaFileUrl: 'https://www.figma.com/board/EnvFixture123/Synthetic', docStructureHint: 'freeform', ingestMode: 'max_speed'}); }
    catch (cause) { error = cause.message; }
    console.log(JSON.stringify({error, fetchCalls}));
  `], { cwd: directory, env: { ...env, ...extra }, encoding: "utf8", timeout: 15_000 });
}

function resultData(result: ReturnType<typeof runServer>) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

describe("explicit environment files", () => {
  it.each([
    { value: "", hasEnvFile: false }, { value: "", hasEnvFile: true },
    { value: " \t ", hasEnvFile: false }, { value: " \t ", hasEnvFile: true },
  ])("treats a blank env-file setting as unset (%j)", async ({ value, hasEnvFile }) => {
    if (hasEnvFile) {
      await writeFile(path.join(directory, ".env"), "LLM_API_KEY=unselected-key-478320\n");
    }
    const result = runServer({ FIGJAM_MCP_ENV_FILE: value });
    const data = resultData(result);
    expect(result.stderr).toBe("");
    expect(data).toEqual(resultData(runServer()));
    expect(data.key).toBeUndefined();
    expect(data.configurationMessage.includes("no longer loaded since 0.12.0")).toBe(hasEnvFile);
    expect(data.configurationMessage).not.toContain("could not load");
  });

  it("starts in a directory with a foreign .env without adopting any value or disabling redaction", async () => {
    await writeFile(path.join(directory, ".env"), "LLM_BASE_URL=https://attacker.invalid/v1\nLLM_API_KEY=foreign-key-815269\nFIGJAM_MCP_REDACT_CREDENTIALS=false\n");
    const result = runServer();
    expect(resultData(result)).toEqual({ masked: "API key: [redacted]", configurationMessage: expect.stringContaining("no longer loaded since 0.12.0") });
    expect(result.stderr).not.toContain("attacker.invalid");
    expect(result.stderr).not.toContain("foreign-key-815269");
  });

  it("loads exactly the configured file while inherited values including empty strings win", async () => {
    const filename = path.join(directory, "selected.env");
    await writeFile(path.join(directory, ".env"), "LLM_API_KEY=unselected-key-478320\n");
    await writeFile(filename, "LLM_BASE_URL=https://selected.invalid/v1\nLLM_API_KEY=selected-key-827345\nFIGJAM_MCP_REDACT_CREDENTIALS=false\n");
    const result = runServer({ FIGJAM_MCP_ENV_FILE: filename, LLM_BASE_URL: "https://client.invalid/v1", FIGJAM_MCP_REDACT_CREDENTIALS: "" });
    expect(resultData(result)).toEqual({ baseURL: "https://client.invalid/v1", key: "selected-key-827345", redaction: "", masked: "API key: [redacted]" });
    expect(result.stderr).toContain(`FIGJAM_MCP_ENV_FILE loaded ${JSON.stringify(filename)}; variables: LLM_API_KEY.`);
    for (const value of ["selected-key-827345", "unselected-key-478320", "https://selected.invalid/v1", "https://client.invalid/v1"]) expect(result.stderr).not.toContain(value);
  });

  it.each(["missing.env", "unreadable-directory"])("keeps startup alive and attaches the load failure for %s", async filename => {
    if (filename === "unreadable-directory") await mkdir(path.join(directory, filename));
    const selected = path.join(directory, filename);
    const result = runServer({ FIGJAM_MCP_ENV_FILE: selected });
    const data = resultData(result);
    expect(result.stderr.trim()).toMatch(/^FIGJAM_MCP_ENV_FILE could not load .*: E(?:NOENT|ISDIR)\.$/);
    expect(data.configurationMessage).toContain(` ${result.stderr.trim()}`);
    expect(data.configurationMessage).not.toContain("no longer loaded");
  });

  it("does not emit the migration hint without a working-directory .env", () => {
    expect(resultData(runServer()).configurationMessage).not.toContain("no longer loaded");
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
    const data = resultData(runMissingFigma(extra));
    expect(data.fetchCalls).toBe(0);
    expect(data.error).toContain("set FIGMA_ACCESS_TOKEN");
    expect(data.error.includes("no longer loaded since 0.12.0")).toBe(kind === "regular file");
    expect(data.error).not.toContain("foreign-token-498172");
  });

  it("includes the explicit env-file load failure in a missing Figma token error before any request", async () => {
    await writeFile(path.join(directory, ".env"), "FIGMA_ACCESS_TOKEN=foreign-token-498172\n");
    const result = runMissingFigma({ FIGJAM_MCP_ENV_FILE: path.join(directory, "missing.env") });
    const data = resultData(result);
    expect(data.fetchCalls).toBe(0);
    expect(data.error).toContain("set FIGMA_ACCESS_TOKEN");
    expect(data.error).toContain(result.stderr.trim());
    expect(data.error).not.toContain("no longer loaded");
    expect(data.error).not.toContain("foreign-token-498172");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("does not read an unreadable .env when constructing the migration hint", async () => {
    await writeFile(path.join(directory, ".env"), "LLM_API_KEY=unreadable-value-678102\n");
    await chmod(path.join(directory, ".env"), 0);
    expect(resultData(runServer()).configurationMessage).toContain("no longer loaded since 0.12.0");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps startup alive when the selected file cannot be read", async () => {
    const selected = path.join(directory, "private.env");
    await writeFile(selected, "LLM_API_KEY=unreadable-value-678102\n");
    await chmod(selected, 0);
    const result = runServer({ FIGJAM_MCP_ENV_FILE: selected });
    const data = resultData(result);
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
    process.env.FIGJAM_MCP_ENV_FILE = "~/selected.env";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    loadConfiguredEnvFile();
    expect(process.env.ENV_FILE_SYNTHETIC_VALUE).toBe("loaded");
    vi.doUnmock("node:os");
  });
});
