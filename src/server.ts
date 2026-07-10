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
import {
  diagnoseLlmConfigInputShape,
  diagnoseLlmConfigOutputShape,
} from "./schemas/diagnoseLlmConfig.js";
import { diffBoardInputShape, diffBoardOutputShape } from "./schemas/diffBoard.js";
import { ingestBoard } from "./tools/ingestBoard.js";
import { getBoardContext } from "./tools/getBoardContext.js";
import { answerFromBoard } from "./tools/answerFromBoard.js";
import { diagnoseLlmConfig } from "./tools/diagnoseLlmConfig.js";
import { diffBoard } from "./tools/diffBoard.js";

/**
 * Builds the MCP server and registers all tools.
 *
 * Error handling: handlers throw plain Errors with actionable messages; the
 * MCP SDK catches anything thrown inside registerTool() handlers and turns
 * it into { isError: true, content: [{ type: "text", text: message }] }, so
 * no per-tool try/catch is needed here.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "figjam-context-mcp",
    version: "0.3.0",
  });

  server.registerTool(
    "ingest_board",
    {
      title: "Ingest FigJam Board",
      description:
        "Reads a FigJam/Figma file, clusters its content, extracts connector-arrow relations, and caches it under a boardId for later get_board_context / answer_from_board calls. Clusters can be mapped to built-in framework phases (double_diamond, lean_canvas, retro, user_journey) or free-form customPhases.",
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

  server.registerTool(
    "diff_board",
    {
      title: "Diff Board Snapshots",
      description:
        "Compares the two most recent ingest snapshots of a board (or further back via compareTo) and reports new, removed, and modified clusters, node changes, and connector changes. Run ingest_board first to capture the current board state.",
      inputSchema: diffBoardInputShape,
      outputSchema: diffBoardOutputShape,
    },
    async (input) => {
      const output = await diffBoard(input);
      return {
        content: [{ type: "text" as const, text: output.summaryText }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "diagnose_llm_config",
    {
      title: "Diagnose LLM Config",
      description:
        "Checks the active free-model LLM configuration with small text and vision JSON calls.",
      inputSchema: diagnoseLlmConfigInputShape,
      outputSchema: diagnoseLlmConfigOutputShape,
    },
    async () => {
      const output = await diagnoseLlmConfig();
      return {
        content: [{ type: "text" as const, text: output.summary }],
        structuredContent: output,
      };
    },
  );

  return server;
}
