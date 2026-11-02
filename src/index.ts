#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfiguredEnvFile } from "./lib/envFile.js";
import { redactMessage } from "./lib/secrets.js";

loadConfiguredEnvFile();
let packageName = "figjam-context-mcp";

async function main(): Promise<void> {
  const { createServer, packageMetadata } = await import("./server.js");
  packageName = packageMetadata.name;
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${packageMetadata.version}\n`);
    return;
  }

  const handle = serveStdio(() => createServer());
  const shutdown = () => { void handle.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.error(`${packageMetadata.name} running on stdio`);
}

await main().catch((error: unknown) => {
  console.error(redactMessage(`Fatal error starting ${packageName}: ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});
