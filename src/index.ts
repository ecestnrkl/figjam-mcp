import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("figjam-context-mcp running on stdio");
}

main().catch((error: unknown) => {
  console.error("Fatal error starting figjam-context-mcp:", error);
  process.exit(1);
});
