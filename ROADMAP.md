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
- [ ] Public demo board and a screen recording in a real MCP client
- [ ] Use it in real workshops; fix what gets in the way
- [x] npm trusted publishing from CI

## 0.5.0 — safer provider calls

- [x] Redact explicit credentials (e.g. "Passwort: …", "API key: …") before board text reaches the cache, tool output or an LLM provider

## 0.6.0 — context that fits client limits

- [x] `maxChars` bounds the whole structured `get_board_context` result; compact text and metadata, board overview, page position

## 0.7.0 — large boards

- [x] Vision only where there is something to see; start a vision call only when it can finish
- [x] Read pages, sections, frames and groups by ID; the first page lists sections with IDs

## 0.8.0 — denser context pages

- [ ] Excerpt text once in `structuredContent`
- [ ] Location per cluster instead of per excerpt

## 0.9.0 — images without Figma renders

- [ ] Image fills (Tier 2) instead of renders (Tier 1)
- [ ] `focusNodeIds` lets the host choose which images to interpret first

## 0.10.0 — tables as tables

- [ ] Rows and columns from cell geometry

## Proven in real use

- [ ] Public demo board and a screen recording
- [ ] Real workshops

## Later — only when real usage asks for it

- Background image interpretation with a daily limit
- Votes and sticky colors
- Answer-kind refinements
