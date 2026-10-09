# Changelog

## 0.4.0 — Unreleased

- Migrate to stable MCP TypeScript SDK v2 and Zod 4, retaining the five stdio tools
  and their existing required response fields. Propagate cancellation and ingest
  progress; declare tool annotations and external-provider behavior.
- Require Node.js 22.12+; update vulnerable runtime and development dependencies.
- Preserve Figma page/section boundaries, tables, connector direction and visual
  changes when interpreting boards and computing snapshot differences.
- Add bounded context pagination and node-level evidence for answers.
  Readable context identifies each source by its node name, keeps its cluster
  label separate, and includes a direct Figma link.
  Local Unicode BM25 includes original text, table cells and descriptive names;
  direct graph neighbors supplement relevant results. No-match topics now return
  empty results. Answers cite only evidence actually supplied to the model.
- Instruct answers to distinguish open tasks, missing confirmation and explicit
  negative facts, and to cite relevant records when explaining uncertainty or
  conflicting sources. Increase the default answer budget to 2,048 tokens to
  accommodate provider reasoning tokens. Add separate opt-in status-question cases for human review;
  valid citation IDs alone do not establish that an answer follows from its source.
- Introduce private validated v4 caches and bounded network/ingest work. Legacy
  caches are preserved and require re-ingestion; see README for migration.
- Add MIT licensing, contribution/security guidance, registry metadata, weekly
  dependency PRs and package installation checks across Linux/macOS/Windows.
- Add 20 synthetic source-retrieval cases with expected changes and an explicit
  opt-in provider evaluator recording requests, token usage and source checks.
- Exercise table-cell changes and historical sources in the production-only
  installed package; test final ingest responses after progress on modern and
  legacy protocols. Add an opt-in 65-second installed-server ingest check.
- Clarify incomplete vision results with actual ingest mode and reason counts;
  validate provider configuration before downloading screenshots, honor shared
  rate-limit cooldowns, and prioritize deferred work over repeated failures.

This entry describes the release candidate. Publication and hosted CI results
must be confirmed before announcing the release.

## 0.3.0 — Development history

Added board snapshot diffs, incremental interpretation, bounded concurrent vision,
connector relations and an npm tarball startup smoke test. No published release
date is asserted for this development version.
