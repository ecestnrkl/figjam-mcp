# figjam-context-mcp

MCP server that turns a FigJam board into queryable context for LLMs. It
exposes three tools:

- **ingest_board** — reads a FigJam/Figma file and caches it under a `boardId`.
- **get_board_context** — returns a text summary and clusters for an ingested board.
- **answer_from_board** — answers a free-form question about an ingested board.

> **Status:** scaffold. The three MCP tools still return mock data — real
> orchestration lands in Schritt 2. A few purely mechanical `lib/` pieces are
> already implemented (no design decisions involved):
> - `figmaApi.ts` — real Figma REST calls (`/files/:key`, `/files/:key/images`, `/images/:key`)
> - `nodeTree.ts` — flattens the real Figma document tree into `NormalizedNode[]`
> - `cache.ts` — working in-memory board store
>
> Still stubbed for Schritt 2 (real design decisions — clustering heuristic,
> vision prompting, Double Diamond mapping, Q&A synthesis, and wiring it all
> together in the tool handlers): `spatialCluster.ts`, `visionInterpreter.ts`,
> `docStructureMapper.ts`, and the orchestration inside `tools/*.ts`.

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
