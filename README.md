# figjam-context-mcp

A local MCP server that turns FigJam boards into source-cited context for LLMs.
It reads a board through the Figma REST API, groups stickies, tables, images and
arrows into clusters, and answers questions with links back to the original nodes.

![Real run: ingest_board reads the demo board, answer_from_board cites two conflicting pilot dates, Figma's MCP server edits the board, ingest_board reports the change, diff_board names the edited sticky and table cell, answer_from_board gives the new date](https://raw.githubusercontent.com/ecestnrkl/figjam-mcp/main/docs/demo.gif)

Rendered from the tool calls and outputs of a real run against the public
[demo board](https://www.figma.com/board/MnLdkszfu3jthPDWHYWRiH/Demo-Board) with
figjam-context-mcp 0.10.2 and `openai/gpt-4.1-mini`. Figma's MCP server
(`use_figma`) made the edit.

## Why

Workshop boards hold research notes, decisions and open questions, but an LLM
cannot read a canvas. Screenshots and PDF exports lose tables, arrow direction
and the link to the source. This server keeps the board's structure and cites
every answer to the nodes it came from.

## Compared with Figma's MCP server

Figma's official MCP server reads a FigJam board or node with its images
(`get_figjam`) and edits boards (`use_figma`). This server turns a workshop
board into context an assistant can cite and track:

- large boards read section by section, with an overview, size-limited pages and search
- a link to the source node for every excerpt and citation
- tables read row by row
- local snapshots, and `diff_board` to see what changed
- explicit credentials redacted before they reach the cache, the output or a model
- image descriptions from a vision model you configure

The two work together: in the demo above, Figma's server edits the board and
this one reports the change.

## Tools

| Tool | What it does | LLM call |
| --- | --- | --- |
| `ingest_board` | Reads a board, clusters it and saves a local snapshot. Re-ingests reuse unchanged clusters; `focusNodeIds` chooses which sections' images are interpreted first. | In `balanced` (default) and `max_quality` mode |
| `get_board_context` | Returns paginated, source-linked context, optionally for a topic or exact node IDs. Use it for overviews, summaries and documentation. | No |
| `answer_from_board` | Answers one specific question (a number, status or decision) from the most relevant excerpts, with node-level citations or an insufficient-evidence result. Not meant for whole-board summaries. | Yes |
| `diff_board` | Compares two snapshots: new, removed and changed clusters, nodes, table cells and arrows. | No |
| `diagnose_llm_config` | Tests the configured models with small text and image JSON checks. | Yes |

## Quick start

Requires Node.js 22.12 or later.

1. Create a Figma personal access token under **Settings → Security → Personal
   access tokens** with the scope `file_content:read`. The token's account
   needs access to the board.
2. Optional: create an OpenRouter key at
   [openrouter.ai/keys](https://openrouter.ai/keys). It enables image
   interpretation, `answer_from_board` and `diagnose_llm_config`. Without it, use
   `ingestMode: "max_speed"` with `get_board_context` and `diff_board`.
3. Add the server to your MCP client. `@latest` makes npx check for a new
   release on every start instead of reusing a cached older version:

```json
{
  "mcpServers": {
    "figjam-context": {
      "command": "npx",
      "args": ["-y", "figjam-context-mcp@latest"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your-figma-token",
        "LLM_BASE_URL": "https://openrouter.ai/api/v1",
        "LLM_API_KEY": "your-openrouter-key"
      }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add figjam-context -e FIGMA_ACCESS_TOKEN=your-figma-token -e LLM_BASE_URL=https://openrouter.ai/api/v1 -e LLM_API_KEY=your-openrouter-key -- npx -y figjam-context-mcp@latest
```

Then ask your assistant to ingest a board URL, for example *"Ingest
https://www.figma.com/board/FILE_KEY/Name and list the open questions."*
The `boardId` of every later call is the file key from that URL. To summarize
a board, the assistant calls `ingest_board`, then `get_board_context` without
parameters, whose first page names the largest sections and lists all sections
with IDs, and then reads the largest sections by passing their IDs as `nodeIds`.
Everything that lies in no section, such as loose notes and tables, comes with
`outsideSections: true`.

All settings: [configuration](https://github.com/ecestnrkl/figjam-mcp/blob/main/docs/configuration.md).
Problems: [troubleshooting](https://github.com/ecestnrkl/figjam-mcp/blob/main/docs/troubleshooting.md).

## How it works

![Pipeline: a FigJam board is read through the Figma API, clustered by geometry, refined with vision and turned into LLM-ready context](https://raw.githubusercontent.com/ecestnrkl/figjam-mcp/main/docs/pipeline.gif)

1. **Read.** `ingest_board` downloads the board through the Figma REST API on
   every call. `get_board_context` and `answer_from_board` read the saved
   snapshot without a new request.
2. **Normalize.** Nodes become text, table cells, images and connectors, with
   their pages and sections. Tables are read row by row: row and column come
   from the cell IDs, and each row becomes one excerpt.
3. **Cluster.** Nearby nodes are grouped by rotation-aware distance. Arrows
   between groups become directed relations. Clusters without a model label
   are named after their section, and an arrow appears in the context once one
   of its ends, or a section, frame or group around one, is on the page.
4. **Interpret.** In `balanced` mode, clusters with an image, or drawings without
   any text, get a vision-model summary within a 40-second budget; text clusters,
   however short, keep their extracted text. A cluster starts only when the time
   left fits it; unfinished clusters continue on the next ingest. With
   `focusNodeIds`, the images of the given sections, frames or nodes come first.
5. **Serve.** The snapshot is saved to a private local cache.
   `get_board_context` searches it (BM25 over original text, table rows and
   names), `answer_from_board` answers with citations and `diff_board` compares
   snapshots. Its first page lists the board's sections with IDs; pass a page,
   section, frame or group ID as `nodeIds` to read everything inside it; several
   IDs in one call take turns, so each of them appears on every page. Its text
   `content` is the readable page; `structuredContent` holds the same data without
   repeating it, with excerpts in `evidence` and location per cluster in `clusters`.

## Models and cost

The default preset `student-free` uses free OpenRouter models: text and images go
to `openrouter/free`, which picks a free model that supports structured outputs
(and images, for images). The free default is best effort: free models change, hit rate limits
and time out. A request to `openrouter/free` or `openrouter/auto` that fails with
a provider error is sent once more, since the router may pick another model. Images go to the model with at most 1,024 px on the longest side;
larger ones are scaled down locally.

- OpenRouter allows free models 20 requests per minute and 50 requests per day,
  or 1,000 per day once you have bought at least 10 credits
  ([limits](https://openrouter.ai/docs/api-reference/limits)).
- Figma limits requests by seat and plan
  ([rate limits](https://developers.figma.com/docs/rest-api/rate-limits/)). File
  downloads and image renders are Tier 1: Dev and Full seats on paid plans get
  10–20 requests per minute, View and Collab seats and files in Starter plans at
  most 20 per month. Every `ingest_board` call is one file download, so a View or
  Collab seat allows about 20 ingests a month. Images come from the image fills instead, Tier 2 with at
  least 5 requests per minute, in one request per ingest. Renders are left for
  drawings without an image and as a fallback for single images; one render
  request covers up to 18 nodes. `max_speed` needs neither.
- For a team, configure your own model: `LLM_BASE_URL` takes any
  OpenAI-compatible endpoint, and `LLM_TEXT_MODELS` / `LLM_VISION_MODELS` set
  the model lists.
- Run `diagnose_llm_config` after every model change. It checks JSON replies
  and image understanding with synthetic inputs.

## Privacy

- The server reads from Figma and never changes a board.
- `balanced` and `max_quality` ingests send board text and images (originals or
  renders) to the configured LLM provider. `answer_from_board` sends the question and selected
  excerpts. `max_speed` with `get_board_context` and `diff_board` sends nothing
  to an LLM provider.
- Snapshots stay in a private per-user cache on your machine. Delete the cache
  directory to remove them.
- Explicit credentials such as `Passwort: …` or API keys are redacted before they
  reach the cache, tool output or an LLM provider
  ([`FIGJAM_MCP_REDACT_CREDENTIALS`](docs/configuration.md#privacy)). This is a
  safety net, not a guarantee: images are not redacted, so keep credentials
  off the board.
- Keep tokens in the client's environment. A token passed as a tool argument can
  appear in client logs.

## Limitations

- Image interpretation gets 40 seconds per ingest by default; large boards need
  several ingests to interpret every image cluster.
- A client that cancels an ingest, for example after a 60-second timeout, gets
  no partial result.
- Free models are best effort. Citations show where an answer comes from, not
  that its conclusion is right.
- Search is lexical; synonyms without shared words do not match.
- Local stdio only; no hosted or multi-user mode.

Measured results: [evaluation](https://github.com/ecestnrkl/figjam-mcp/blob/main/docs/evaluation.md).

## Development

```bash
git clone https://github.com/ecestnrkl/figjam-mcp.git
cd figjam-mcp
npm ci
cp .env.example .env    # add your tokens
npm run check           # typecheck, tests, build, package validation
npm run package:smoke   # install the packed package and exercise all tools
npm run eval:retrieval  # offline retrieval and diff evaluation
npx @modelcontextprotocol/inspector --config inspector.config.json
```

See [CONTRIBUTING.md](https://github.com/ecestnrkl/figjam-mcp/blob/main/CONTRIBUTING.md)
and the [changelog](https://github.com/ecestnrkl/figjam-mcp/blob/main/CHANGELOG.md).

## License

[MIT](https://github.com/ecestnrkl/figjam-mcp/blob/main/LICENSE) © 2026 ecestnrkl
