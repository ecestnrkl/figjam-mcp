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
import { answerFromBoard } from "./tools/answerFromBoard.js";
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
        "Read a FigJam/Figma URL with the configured Figma token and persist a local snapshot for get_board_context, answer_from_board and diff_board; the summary names the largest sections to read next and how many excerpts lie outside sections. Leaves the Figma file unchanged. Balanced/quality modes may send board text and screenshots to the configured LLM provider and incur charges; max_speed skips vision. Re-ingest to refresh stale content; local history is bounded. Supports framework phases or customPhases.",
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
        "Read source-cited context from an ingested board snapshot: original text, table rows, cluster summaries and arrows, each with a Figma link. Start here for overviews, summaries and documentation with one call without topic, nodeIds, limit and maxChars: its first page names the largest sections and lists all sections with IDs. Then read sections, pages, frames or groups by passing their IDs as nodeIds (several IDs in one call share every page), read everything outside sections with outsideSections: true, search words with topic, or continue with cursor, and synthesize the answer yourself. Large pages can exceed client output limits. No network or LLM calls; does not refresh Figma content (use ingest_board).",
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
        "Compare retained local snapshots of the same board, reporting cluster, node and connector changes. Requires at least two distinct ingests. compareTo=1 selects the previous snapshot, 2 selects two states back. No network or LLM calls; ingest_board must capture the current Figma state first.",
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
