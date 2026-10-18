# Changelog

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
