# figjam-context-mcp

MCP server that turns a FigJam board into queryable context for LLMs. It
exposes three tools:

- **ingest_board** — reads a FigJam/Figma file and caches it under a `boardId`.
- **get_board_context** — returns a text summary and clusters for an ingested board.
- **answer_from_board** — answers a free-form question about an ingested board.

> **Status:** scaffold only. All three tools currently return mock data.
> Fachlogik folgt in Schritt 2 (Figma API calls, node flattening, spatial
> clustering, vision-based labeling, Double Diamond mapping).

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` with a Figma personal access token:

1. Log in at [figma.com](https://www.figma.com).
2. Go to **Settings → Security → Personal access tokens**.
3. Generate a new token and paste it into `.env` as `FIGMA_ACCESS_TOKEN`.

(You can also pass a token per-call via the `figmaAccessToken` input on
`ingest_board` instead of using the env var.)

## Run

```bash
npm run dev
```

This starts the MCP server over stdio using `tsx watch`.

## Inspect

To try the tools interactively (mock responses for now):

```bash
npx @modelcontextprotocol/inspector npm run dev
```

## Scripts

- `npm run dev` — run the server with `tsx watch` (auto-restart on change).
- `npm run build` — compile TypeScript to `dist/`.
- `npm start` — run the compiled server from `dist/`.
- `npm test` — run the Vitest test suite.

## Project layout

```
src/
├── index.ts               # stdio entrypoint
├── server.ts               # McpServer setup + tool registration
├── tools/                   # tool handlers (mock data for now)
├── schemas/                 # Zod input/output schemas per tool
├── lib/                     # Figma API, clustering, vision, cache (stubs)
└── types.ts                 # shared domain types
```
