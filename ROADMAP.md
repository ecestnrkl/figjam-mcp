# Roadmap

Goal: a dependable MCP server that turns FigJam workshops into source-cited context —
installable in two minutes, documented, and used on real boards.

## 0.4.0 — first public release

- [ ] Release PR #7: current free-model defaults, ingest fits a 60 s client timeout, concise docs
- [ ] Merge, tag `v0.4.0`, GitHub release
- [ ] Publish to npm and the MCP Registry, refresh the Glama listing

## 0.4.x — proven in real use

- [ ] Public demo board and a screen recording in a real MCP client
- [ ] Use it in real workshops; fix what gets in the way
- [ ] npm trusted publishing from CI

## Later — only when real usage asks for it

- Keep partial ingest progress when a client cancels; MCP Tasks for long ingests
- Redact obvious credentials before board text is sent to a provider
- Answer-kind refinements (task vs. question vs. proposal)
- Literal handling of unlabelled statistics in images
