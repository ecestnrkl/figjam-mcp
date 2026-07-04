# figjam-context-mcp

MCP server that turns a FigJam board into queryable context for LLMs — read
directly via the Figma REST API, no manual PDF-export detour. It exposes
three tools:

- **ingest_board** — reads a FigJam/Figma file, clusters its content
  spatially, verifies and labels each cluster with a vision model, and
  caches the result under a `boardId` (= the Figma file key).
- **get_board_context** — returns a compact, paste-ready context block plus
  the underlying clusters for an ingested board, optionally scoped to a topic.
- **answer_from_board** — answers a free-form question about an ingested
  board, citing the clusters the answer was derived from.

## How it works

FigJam boards are spatially chaotic: rotated stickies, overlapping shapes,
embedded screenshots, no reading order. The pipeline therefore combines
geometry with vision:

1. `fetchFileTree` + `flattenNodeTree` — pull the raw node tree and flatten
   it into normalized nodes (position, size, rotation, text, image refs),
   dropping empty structural noise.
2. `geometricPreCluster` — rotation-aware distance clustering into coarse
   groups.
3. `refineClusterWithVision` — per cluster, node screenshots + extracted
   text go to a vision model in one request; it confirms which nodes belong
   together, labels the group, describes embedded images, and writes a 3–5
   sentence summary.
4. `mapToDoubleDiamond` (optional, `docStructureHint: "double_diamond"`) —
   assigns each cluster to Discover / Define / Develop / Deliver (or
   "unclear").
5. Results are cached in-memory per file key; `get_board_context` and
   `answer_from_board` read from the cache.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

**`FIGMA_ACCESS_TOKEN`** — log in at [figma.com](https://www.figma.com), go
to **Settings → Security → Personal access tokens**, generate a token. (Can
also be passed per-call via the `figmaAccessToken` input on `ingest_board`.)

**`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_VISION_MODEL` / `LLM_TEXT_MODEL`** —
any OpenAI-compatible endpoint. Free options:

- **OpenRouter** (default in `.env.example`): get a key at
  [openrouter.ai/keys](https://openrouter.ai/keys). The preconfigured
  `openrouter/free` model id is OpenRouter's Free Models Router, which
  auto-routes to a live free model that supports image input — individual
  `:free` models come and go, the router doesn't. Free tier (~20 req/min,
  200/day) comfortably covers occasional board scans.
- **GitHub Models**: free with any GitHub account — create a token at
  [github.com/marketplace/models](https://github.com/marketplace/models),
  set `LLM_BASE_URL=https://models.github.ai/inference`.

The same model can serve both the vision and text roles; the two variables
exist so they're easy to split later.

## Run

```bash
npm run dev
```

This starts the MCP server over stdio using `tsx watch`. To try the tools
interactively:

```bash
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

> **Note:** don't pass plain `npm run dev` to the Inspector (or any MCP
> client) — npm prints a `> figjam-context-mcp@0.1.0 dev` banner to stdout
> before the server starts, which corrupts the JSON-RPC stream the client
> expects there. Either invoke `tsx` directly as above, or add `--silent`:
> `npx @modelcontextprotocol/inspector npm run dev --silent`.

## Usage example

Paste in a Figma board link and ingest it:

```jsonc
// tool: ingest_board
{
  "figmaFileUrl": "https://www.figma.com/board/AbC123XyZ456/Semester-Project-Research",
  "docStructureHint": "double_diamond"
}
// → { "boardId": "AbC123XyZ456", "clusterCount": 5,
//     "summary": "Ingested board AbC123XyZ456: 5 clusters — \"User interview quotes\", \"Problem framing\", …" }
```

The `boardId` is the file key itself — re-running `ingest_board` on the same
file refreshes the cache entry. Then pull context, optionally scoped to a
topic:

```jsonc
// tool: get_board_context
{ "boardId": "AbC123XyZ456", "topic": "user research" }
// → contextText:
// FigJam board AbC123XyZ456 — 2 of 5 clusters (topic: user research):
//
// ## User interview quotes [discover]
// Sticky notes with verbatim quotes from six student interviews about exam
// stress. Two embedded screenshots show survey results (bar charts of study
// habits). Main pain points: unclear requirements and late feedback. …
```

The `contextText` block is deliberately token-lean — paste it straight into
a documentation-writing chat (e.g. for a semester report). Or ask directly:

```jsonc
// tool: answer_from_board
{ "boardId": "AbC123XyZ456", "question": "What were the main user pain points?" }
// → { "answer": "Unclear requirements and late feedback …",
//     "citedClusters": ["User interview quotes", "Problem framing"] }
```

## Scripts

- `npm run dev` — run the server with `tsx watch` (auto-restart on change).
- `npm run build` — compile TypeScript to `dist/`.
- `npm start` — run the compiled server from `dist/`.
- `npm test` — run the Vitest test suite.

## Project layout

```
src/
├── index.ts        # stdio entrypoint
├── server.ts       # McpServer setup + tool registration
├── tools/          # tool handlers (ingest pipeline, context, Q&A)
├── schemas/        # Zod input/output schemas per tool
├── lib/            # Figma API, node tree, clustering, vision, LLM, cache
└── types.ts        # shared domain types
```
