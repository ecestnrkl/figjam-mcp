import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { redactMessage } from "./secrets.js";

let loadError: string | undefined;

export function expandHomePath(value: string): string {
  return value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

/** Load only the file explicitly selected by the MCP client; inherited values win. */
export function loadConfiguredEnvFile(): void {
  loadError = undefined;
  const configuredPath = process.env.FIGJAM_MCP_ENV_FILE;
  if (!configuredPath?.trim()) return;
  const filename = expandHomePath(configuredPath);
  try {
    const values = parseEnv(readFileSync(filename, "utf8").replace(/^\uFEFF/, ""));
    const loaded: string[] = [];
    for (const [name, value] of Object.entries(values)) {
      if (process.env[name] !== undefined) continue;
      process.env[name] = value;
      loaded.push(name);
    }
    console.error(redactMessage(`FIGJAM_MCP_ENV_FILE loaded ${JSON.stringify(filename)}; variables: ${loaded.join(", ") || "(none)"}.`));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unable to read or parse the file";
    loadError = `FIGJAM_MCP_ENV_FILE could not load ${JSON.stringify(filename)}: ${reason}.`;
    console.error(redactMessage(loadError));
  }
}

/** Extra context only for errors about missing required credentials or endpoint. */
export function missingEnvironmentHint(): string {
  if (loadError) return ` ${redactMessage(loadError)}`;
  if (!process.env.FIGJAM_MCP_ENV_FILE?.trim() && hasWorkingDirectoryEnvFile()) {
    return " A .env file in the working directory is no longer loaded since 0.12.0; set variables in the MCP client configuration or set FIGJAM_MCP_ENV_FILE to its absolute path.";
  }
  return "";
}

function hasWorkingDirectoryEnvFile(): boolean {
  try { return statSync(path.join(process.cwd(), ".env")).isFile(); }
  catch { return false; }
}
