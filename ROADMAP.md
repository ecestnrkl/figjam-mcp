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

## 0.12.0 — hardened for user tests

- [x] Configuration only from the MCP client; broader credential redaction; hidden elements left out
- [x] Figma, model-provider and input errors name the cause and the next step; fewer Figma requests for images
- [x] Snapshots stay readable when servers share a cache or a file is damaged; bounded `diff_board` lists
- [x] Search ignores accents and hyphens; reading paths offer cursors, Figma links and citation guidance
- [x] Quick start for testers with a success check

## 0.13.0 — dependable on unfamiliar boards

- [x] Contents hidden inside a FigJam section stay out of snapshots, images and provider requests; URL passwords are redacted
- [x] Connection, proxy, certificate, model and configuration errors name the cause and the next step; branch links work
- [x] Search finds common word forms and compounds with exact matches first and suggests board words on a miss
- [x] Slightly offset rows read left to right; `diff_board` names moves, resizes and regrouped clusters; hosts get the workflow at initialization and page reads stay fast on boards with many sections

## 1.0.0 — proven in real use

- [x] Public demo board and a screen recording
- [ ] User tests on real workshop boards: three to five people install from the README in their own MCP client, ask their own questions and check the citations; friction becomes issues
- [ ] Fix what the tests show before anything new
- [ ] Stable tool contract: tool names, input schemas and required output fields are frozen and documented. Decide before the freeze:
  - the length limit of `nodeIds` and `focusNodeIds` entries, so that a Figma link with a long board name fits
  - which excerpt fields stay when they follow from others, such as `url` from `nodeId`
  - what `snapshotId` identifies: the board content alone, or also image interpretations, which can change between ingests
  - how much of the output schemas `tools/list` advertises

## Later — only when real usage asks for it

Each item names the observation that would justify it.

- An outline for boards that use frames instead of sections — if testers' boards are organized in frames
- Background image interpretation with a daily limit — if image interpretation regularly outlasts client timeouts on real boards
- Votes and sticky colors — if testers ask about voting results or color coding
- Answer-kind refinements — if answers to real questions misjudge whether something is confirmed, proposed or contested
- Semantic search (local embeddings or hybrid ranking) — if user tests show frequent paraphrased or cross-language questions that hosts do not rephrase after a miss
- Model-suggested search words in `answer_from_board` — if hosts call `answer_from_board` and its misses are mostly synonyms or another language
- Fuzzy matches for typos — if similar-word suggestions do not lead hosts to a successful second search
- An opt-in to read hidden section contents — if a facilitator asks for hidden sections to be included
- Column headings and background shapes as group boundaries — if boards without sections merge neighboring groups or read columns in the wrong order
- More credential formats and placeholder values — if a real board shows a missed key or a redacted placeholder
- Detection of personal data beyond credentials — if testers' boards hold names or contact details they do not want sent to a provider
- Link preview content and sticky authors — if testers ask for them and Figma's REST API returns them
