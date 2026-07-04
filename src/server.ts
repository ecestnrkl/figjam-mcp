import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ingestBoardInputShape,
  ingestBoardOutputShape,
} from "./schemas/ingestBoard.js";
import {
  getBoardContextInputShape,
  getBoardContextOutputShape,
} from "./schemas/getBoardContext.js";
import {
  answerFromBoardInputShape,
  answerFromBoardOutputShape,
} from "./schemas/answerFromBoard.js";
import { ingestBoard } from "./tools/ingestBoard.js";
import { getBoardContext } from "./tools/getBoardContext.js";
import { answerFromBoard } from "./tools/answerFromBoard.js";

/**
 * Builds the MCP server and registers all three tools. Handlers currently
 * return mock data only — real board ingestion/clustering/Q&A logic lands
 * in a follow-up step.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "figjam-context-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "ingest_board",
    {
      title: "Ingest FigJam Board",
      description:
        "Reads a FigJam/Figma file, clusters its content, and caches it under a boardId for later get_board_context / answer_from_board calls.",
      inputSchema: ingestBoardInputShape,
      outputSchema: ingestBoardOutputShape,
    },
    async (input) => {
      const output = await ingestBoard(input);
      return {
        content: [{ type: "text" as const, text: output.summary }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "get_board_context",
    {
      title: "Get Board Context",
      description:
        "Returns a text summary plus the underlying clusters for a previously ingested board, optionally scoped to a topic.",
      inputSchema: getBoardContextInputShape,
      outputSchema: getBoardContextOutputShape,
    },
    async (input) => {
      const output = await getBoardContext(input);
      return {
        content: [{ type: "text" as const, text: output.contextText }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "answer_from_board",
    {
      title: "Answer From Board",
      description:
        "Answers a free-form question about a previously ingested board, citing the clusters the answer was derived from.",
      inputSchema: answerFromBoardInputShape,
      outputSchema: answerFromBoardOutputShape,
    },
    async (input) => {
      const output = await answerFromBoard(input);
      return {
        content: [{ type: "text" as const, text: output.answer }],
        structuredContent: output,
      };
    },
  );

  return server;
}
