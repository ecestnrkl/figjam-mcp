# Changelog

## 0.8.0 — 2026-10-19

- `get_board_context` sends excerpt text once: `structuredContent.contextText` no longer contains
  excerpts, only orientation (header, page position, overview), and the text `content` carries the full
  readable page. `maxChars` bounds both; `evidence` follows the clusters, each cluster states its page and
  sections once, and deterministic clusters have an empty `summary`. Pages hold about 1.6 times as many excerpts.
- On boards with sections, the `ingest_board` summary names the 8 largest sections with ID, name and
  excerpts instead of the first cluster labels, and the unfocused first page of `get_board_context` names
  the 10 largest before the section tree; tool descriptions send summaries, lists, risks and next steps
  across sections to `get_board_context` instead of `answer_from_board`.
- Tables now come as row excerpts with `sourceType` `table_row` instead of one `table_cell` excerpt per
  cell: row and column are derived from the cell IDs, also for existing snapshots, and each row lists its
  cells in column order separated by " | ". A cell ID in `nodeIds` returns its row, the table ID all rows;
  a topic match in a later row brings the first row with the column headings; the text shows consecutive
  rows of a table as one block. Tables whose rows cannot be derived keep `table_cell` excerpts.

## 0.7.0 — 2026-10-19

- `ingest_board` in `balanced` mode interprets only clusters with an image or drawings without text;
  short text labels keep their text and pending ones complete on the next ingest without a request.
  A cluster or model step starts only if the time left fits 1.25 × its median duration in the ingest.
- `get_board_context` reads a page, section, frame or group by its ID in `nodeIds`: all excerpts inside,
  nested sections included, cluster by cluster in reading order; the first page lists its direct
  subsections. The unfocused first page lists all sections as a tree with IDs, excerpt counts and images
  not yet interpreted, instead of the 10 largest; with more than 5 pages left it suggests reading by section.

## 0.6.0 — 2026-10-19

- `get_board_context` fits clients that pass only `structuredContent` to the model: `maxChars` now
  bounds the whole structured result; the text groups excerpts by cluster without repeating node names,
  repeated optional evidence fields and deterministic summary highlights are left out, each page states
  its position (an unfocused first page starts with a board overview), and a partial long node points to
  a `nodeIds` request for all parts; pages, sections and default-named layers ("Frame 12", "Vector")
  are no longer separate excerpts, and name-only metadata follows all content. Pages hold fewer
  excerpts; continue with `nextCursor`.
- README and troubleshooting start the server with `figjam-context-mcp@latest`, so `npx` picks up new releases.

## 0.5.1 — 2026-10-19

- `ingest_board` now redacts snapshot data it reuses (unchanged board, cache hit,
  reused cluster labels and summaries) before vision prompts, its output and the cache,
  so a board first ingested with `FIGJAM_MCP_REDACT_CREDENTIALS=false` no longer
  keeps unredacted text once redaction is switched back on.

## 0.5.0 — 2026-10-19

- Explicit credentials are redacted as `[redacted]` during extraction, before they
  reach the cache, tool output or an LLM provider: labelled values such as
  `Passwort: …`, `PIN: …`, `API key: …` or `Client Secret: …` up to the end of the
  line, in node names, text and table cells, and known key formats (GitHub,
  OpenAI/OpenRouter, Figma, AWS, Slack, private key blocks). Snapshots cached by
  earlier versions are redacted when `get_board_context`, `answer_from_board` and
  `diff_board` read them. Turn it off with `FIGJAM_MCP_REDACT_CREDENTIALS=false`.
- **Re-ingest each board once** so its cached snapshot is stored redacted; the
  next `ingest_board` re-extracts even when Figma reports no change.
- The release workflow waits until npm serves the new version before publishing
  to the MCP Registry, retries that step, and creates the GitHub release independently.

## 0.4.1 — 2026-10-19

- `answer_from_board` waits up to 40 s per model request (`LLM_ANSWER_REQUEST_TIMEOUT_MS`)
  instead of 20 s and stops after 50 s across all model candidates, so large prompts
  on free reasoning models finish inside a 60-second client timeout. The text checks of
  `diagnose_llm_config` use the same timeout, and timeout errors name the setting to change.
- Tool descriptions point overviews and whole-board summaries to `get_board_context`;
  `answer_from_board` is for one specific question.
- `ingest_board` renders screenshots of several clusters per Figma request (up to
  18 nodes) instead of one request per cluster, saving Tier 1 Figma requests.
- Vision summaries keep table values and statistical notation literally and name
  a statistic such as a confidence interval only when a legend identifies it.
- Releases are published from CI with npm provenance.
- Dependency updates: `openai` 7.34, `dotenv` 18.0.8.

## 0.4.0 — 2026-10-18

- New `student-free` defaults: text uses `nvidia/nemotron-3-super-120b-a12b:free`,
  then `openrouter/free`; vision uses `openrouter/free`. OpenRouter's
  `provider.require_parameters` is no longer sent to other providers.
- `ingest_board` fits a 60-second client timeout: the vision phase defaults to
  40 s (`INGEST_BOARD_VISION_BUDGET_MS`). Unfinished clusters continue on the
  next ingest, and the summary says so.
- `diagnose_llm_config` runs its checks in parallel with the same output budgets
  as the real calls and answers within 45 s.
- Stable MCP TypeScript SDK v2 and Zod 4 with unchanged tool names and required
  fields; cancellation, ingest progress and tool annotations. Requires Node.js 22.12+.
- Answers cite source nodes with exact quotes and Figma links, and report
  insufficient evidence instead of guessing.
- Answers keep confirmed statuses, explicit negatives, open tasks, proposals and
  conflicting sources apart. Optional `LLM_ANSWER_REASONING_EFFORT` for answers.
- `get_board_context` adds pagination, character budgets, exact node lookups and
  local BM25 search over original text, table cells and names. Topics without
  matches return empty results.
- Tables, pages, sections and arrow direction are preserved. Arrows anchored to
  the page canvas no longer create connections.
- `diff_board` compares the latest snapshot with an earlier one (20 are kept),
  including table-cell, visual and connector changes.
- Re-ingests reuse unchanged clusters and skip the download when Figma reports
  the same version. Model or prompt changes invalidate interpretations automatically.
- Ingest results report why vision is incomplete (time budget, timeout, rate
  limit, configuration, access) and when to retry; Retry-After is respected.
- Private v4 cache with atomic writes and a write lock. Legacy v3 caches are kept;
  re-ingest once after upgrading.
- Bounded work: 64 MiB per file, 100,000 nodes, 8 MiB per image, 64 MiB of
  screenshots per ingest, and per-request timeouts for Figma and the LLM.
- Vision summaries keep visible facts and diagram direction and are marked as
  model-derived.
- Offline retrieval and diff evaluation with 20 synthetic cases
  (`npm run eval:retrieval`); MIT license and CI on Linux, macOS and Windows.

## 0.3.0 — Development history

Added board snapshot diffs, incremental interpretation, bounded concurrent vision,
connector relations and an npm tarball startup smoke test. No published release
date is asserted for this development version.
