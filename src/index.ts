#!/usr/bin/env node

import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, packageMetadata } from "./server.js";

async function main(): Promise<void> {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${packageMetadata.version}\n`);
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${packageMetadata.name} running on stdio`);
}

main().catch((error: unknown) => {
  console.error(`Fatal error starting ${packageMetadata.name}:`, error);
  process.exit(1);
});
