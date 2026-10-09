#!/usr/bin/env node

import "dotenv/config";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, packageMetadata } from "./server.js";

async function main(): Promise<void> {
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

main().catch((error: unknown) => {
  console.error(`Fatal error starting ${packageMetadata.name}:`, error);
  process.exit(1);
});
