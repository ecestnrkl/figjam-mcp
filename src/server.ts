import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ingestBoardInputSchema,
  ingestBoardOutputShape,
} from "./schemas/ingestBoard.js";
import {
  getBoardContextInputSchema,
  getBoardContextOutputShape,
} from "./schemas/getBoardContext.js";
import {
  answerFromBoardInputSchema,
  answerFromBoardOutputShape,
} from "./schemas/answerFromBoard.js";
import {
  diagnoseLlmConfigInputSchema,
  diagnoseLlmConfigOutputShape,
} from "./schemas/diagnoseLlmConfig.js";
import { diffBoardInputSchema, diffBoardOutputShape } from "./schemas/diffBoard.js";
import { ingestBoard } from "./tools/ingestBoard.js";
import { getBoardContext } from "./tools/getBoardContext.js";
import { answerFromBoard, answerText } from "./tools/answerFromBoard.js";
import { diagnoseLlmConfig } from "./tools/diagnoseLlmConfig.js";
import { diffBoard } from "./tools/diffBoard.js";

interface PackageMetadata {
  name: string;
  version: string;
}

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function loadPackageMetadata(): Readonly<PackageMetadata> {
  const require = createRequire(import.meta.url);
  let rawMetadata: unknown;

  try {
    rawMetadata = require("../package.json");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read package metadata: ${detail}`);
  }

  if (typeof rawMetadata !== "object" || rawMetadata === null) {
    throw new Error("Invalid package metadata: expected an object");
  }

  const metadata = rawMetadata as Record<string, unknown>;
  if (typeof metadata.name !== "string" || metadata.name.trim() === "") {
    throw new Error("Invalid package metadata: name must be a non-empty string");
  }
  if (
    typeof metadata.version !== "string" ||
    !semverPattern.test(metadata.version)
  ) {
    throw new Error("Invalid package metadata: version must be valid SemVer");
  }

  return Object.freeze({
    name: metadata.name,
    version: metadata.version,
  });
}

export const packageMetadata = loadPackageMetadata();

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
    name: packageMetadata.name,
    version: packageMetadata.version,
  });

  server.registerTool(
    "ingest_board",
    {
      title: "Ingest FigJam Board",
      description:
        "Read a FigJam/Figma URL with the configured Figma token and persist a local snapshot for get_board_context, answer_from_board and diff_board; the summary names the largest sections to read next and how many excerpts lie outside sections. Leaves the Figma file unchanged. Every call downloads the board from Figma (one Tier 1 request); get_board_context and answer_from_board read the saved snapshot without a new request. Balanced/quality modes may send board text and images to the configured LLM provider and incur charges; max_speed skips vision. Re-ingest to refresh stale content and continue pending image interpretation; focusNodeIds with section IDs from the summary or the first page of get_board_context interprets their images first. Local history is bounded. Supports framework phases or customPhases.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: ingestBoardInputSchema,
      outputSchema: z.object(ingestBoardOutputShape),
    },
    async (input, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      const output = await ingestBoard(input, {
        signal: ctx.mcpReq.signal,
        onProgress: progressToken === undefined ? undefined : async (phase, progress, total) => {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken, progress, total, message: phase },
          });
        },
      });
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
        "Read source-cited context from an ingested board snapshot. Start overviews, summaries and documentation with a call without topic, nodeIds, limit and maxChars: its first page names the largest sections and lists sections with IDs. Then pass section, page, frame or group IDs as nodeIds; several IDs share each page in request order. Default detail: \"auto\" switches reads of multiple distinct IDs or one page, section, frame or group to a compact overview only when the first full page would leave unread excerpts. Overview lines contain node IDs and deterministically shortened text (50–120 characters); structuredContent puts the excerpts once in overview.text, with empty evidence and clusters. limit applies only to the full view and is ignored in an overview, even when explicit. Read the complete source and Figma link with the same boardId and snapshotId, nodeIds: [\"<ID>\"] and detail: \"full\"; table IDs read every row. Without overview, excerpts are in evidence. Read outsideSections: true, search with topic, or continue with cursor. Synthesize the answer yourself. No network or LLM calls; use ingest_board to refresh Figma content.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: getBoardContextInputSchema,
      outputSchema: z.object(getBoardContextOutputShape),
    },
    async (input) => {
      const { text, structuredContent } = await getBoardContext(input);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "answer_from_board",
    {
      title: "Answer From Board",
      description:
        "Answer one specific question, such as a number, a status or a decision, from the most relevant excerpts of an ingested board, with validated source citations or an insufficient-evidence result. It reads only a handful of excerpts: not for summaries, lists, risks or next steps across several sections; read those with get_board_context. Sends the question and the selected excerpts to the configured LLM provider; calls may incur charges.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: answerFromBoardInputSchema,
      outputSchema: z.object(answerFromBoardOutputShape),
    },
    async (input, ctx) => {
      const output = await answerFromBoard(input, { signal: ctx.mcpReq.signal });
      return {
        content: [{ type: "text" as const, text: answerText(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "diff_board",
    {
      title: "Diff Board Snapshots",
      description:
        "Compare retained local snapshots of the same board, reporting cluster, node and connector changes. Names each changed node with its section and its old and new text, and each changed table cell with its row and column. Needs two ingests; when the board did not change in between, it reports no changes since the first. compareTo=1 selects the previous snapshot, 2 selects two states back. No network or LLM calls; ingest_board must capture the current Figma state first.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: diffBoardInputSchema,
      outputSchema: z.object(diffBoardOutputShape),
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
        "Test the configured text and vision models with three small synthetic JSON challenges. Sends synthetic text and an image to the configured provider, may incur charges, and reports semantic/schema failures. Does not read board contents. Use after changing model/provider settings.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: diagnoseLlmConfigInputSchema,
      outputSchema: z.object(diagnoseLlmConfigOutputShape),
    },
    async (_input, ctx) => {
      const output = await diagnoseLlmConfig({ signal: ctx.mcpReq.signal });
      return {
        content: [{ type: "text" as const, text: output.summary }],
        structuredContent: output,
      };
    },
  );

  return server;
}
