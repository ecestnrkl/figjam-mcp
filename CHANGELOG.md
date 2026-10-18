# Changelog

## 0.4.0 — Unreleased

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
