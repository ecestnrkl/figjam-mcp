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

## 0.7.0 — complete image interpretation

- [ ] Continue image interpretation in the background after ingest_board returns, capped so free-tier quotas stay usable for answers

## Later — only when real usage asks for it

- Answer-kind refinements (task vs. question vs. proposal)
