# Roadmap

Goal: a dependable MCP server that turns FigJam workshops into source-cited context —
installable in two minutes, documented, and used on real boards.

## 0.4.0 — first public release

- [x] Release PR #7: current free-model defaults, ingest fits a 60 s client timeout, concise docs
- [x] Merge, tag `v0.4.0`, GitHub release
- [x] Publish to npm and the MCP Registry
- [x] Refresh the Glama listing

## 0.4.x — proven in real use

- [x] Render screenshots of several clusters per Figma request
- [x] npm trusted publishing from CI

## 0.5.0 — safer provider calls

- [x] Redact explicit credentials (e.g. "Passwort: …", "API key: …") before board text reaches the cache, tool output or an LLM provider

## 0.6.0 — context that fits client limits

- [x] `maxChars` bounds the whole structured `get_board_context` result; compact text and metadata, board overview, page position

## 0.7.0 — large boards

- [x] Vision only where there is something to see; start a vision call only when it can finish
- [x] Read pages, sections, frames and groups by ID; the first page lists sections with IDs

## 0.8.0 — context that reads like the board

- [x] Excerpt text once in `structuredContent`; location per cluster; first answers point to the largest sections
- [x] Tables as tables: rows and columns from cell IDs

## 0.9.0 — the whole board

- [x] Every requested ID on every page; content outside sections with `outsideSections`
- [x] Image fills (Tier 2) instead of renders (Tier 1)
- [x] `focusNodeIds` lets the host choose which images to interpret first

## 0.10.0 — the board's structure

- [x] Clusters named after their sections; arrows from either end and between sections
- [x] `forceFullIngest` and text model changes keep image interpretations; `student-free` text uses `openrouter/free` only
- [x] `diagnose_llm_config` names every model it tried; short cursors; the ingest summary says whether the board changed

## 0.11.0 — ready for user tests

- [x] Search handles long questions, includes more excerpts in the prompt and answers honestly when evidence is missing
- [x] Read large sections as compact overviews; `detail: "full"` reads complete excerpts
- [x] Ingest uses 8 parallel image requests with paid OpenRouter models, reports progress per image cluster, documents client-specific timeouts and clearly explains HTTP 402

## 1.0.0 — proven in real use

- [x] Public demo board and a screen recording
- [ ] Real workshops
- [ ] Stable tool contract

## Later — only when real usage asks for it

- An outline for boards that use frames instead of sections
- Background image interpretation with a daily limit
- Votes and sticky colors
- Answer-kind refinements
