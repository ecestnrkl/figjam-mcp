# Changelog

## 0.11.0 — Unreleased

- `diagnose_llm_config` uses a pure blue test image to avoid ambiguous color-check failures.
- `diagnose_llm_config` names the active models when environment variables override the preset.
- `diff_board` returns an empty change report after an unchanged re-ingest of a board with one snapshot.
- Unlabeled arrows with identical endpoints are omitted from context connections and their counts.
- README adds setup per client, explicit approval behavior, registry refreshes and limits of section overviews and `max_quality` ingests.
- Missing `LLM_BASE_URL` or `LLM_API_KEY` gives one message in `ingest_board`, `answer_from_board` and
  `diagnose_llm_config` that names every missing variable, points to `env` in the MCP client configuration and says
  to restart the server; `.env` is only mentioned for a local checkout. It named only the first missing variable.
- `diagnose_llm_config` names each failing check with its cause in the text, one line per shared cause; it only
  counted them. `isError` stays false.
- `get_board_context` with `nodeIds` fails when none of the IDs is in the snapshot, naming them and where valid IDs
  come from; it returned an empty page. Unknown IDs among known ones are named in one line and in the new optional
  `unknownNodeIds`; known nodes without excerpts, empty table cells included, are named as containing no text, and
  requested arrows as listed under connections.
- Figma 401/403 errors name `FIGMA_ACCESS_TOKEN`, the scope `file_content:read` and that its account must be able to
  open the file; 404 names the file key instead of the API path.
- Clearer wording: an invalid board URL shows an example URL instead of a pattern, `answer_from_board` without
  matching excerpts says "The board has no excerpts that answer this question." (German likewise), and
  `ingest_board` names the causes of incomplete image interpretation in plain words, with a cluster count per cause
  only when there are several.
- `answer_from_board` removes evidence IDs (`ev_…`) that a model wrote into the answer text, with brackets and
  lead-ins such as "evidence IDs:" they leave behind; the sources are listed below the answer.

## 0.10.3 — 2026-10-22

- `answer_from_board` lists its citations in the text content after the answer, under "Sources (untrusted board data):",
  one line each with node ID, innermost section (else cluster label), quote (at most 200 characters) and link. Clients
  that pass only the text to the model got the answer without sources; `structuredContent` is unchanged.
- `get_board_context` accepts `maxChars` from 2,000 (was 512) and returns a page for every request at that size. Under a
  small budget the model summaries of the clusters on the page now yield too (`summary` is empty), after the overview
  and the page position, before the first excerpt is shortened; 512 to about 1,300 always failed with "The context
  budget cannot fit one source excerpt". The new optional `truncation.omittedSummaries` counts the clusters on the page
  whose model summary is left empty; `truncated` is then true.
- `get_board_context` estimates "Page N of about M" from up to three probe pages built like follow-up pages, at the next
  excerpt and after one and two thirds of the rest, instead of from the first page, whose overview leaves room for few
  excerpts; on large boards it reported several times the real number of pages.
- `diff_board` names the innermost section of each new, removed and modified cluster in the text output, unless its
  label starts with that name (`- "Ideas board" in "3 · Ideas": 1 edited`), and in the new optional `section` of those
  entries. A model label alone did not say where on the board the cluster is.

## 0.10.2 — 2026-10-21

- `diff_board` names each edited, added and removed node, in the text output and in the new optional `nodeChanges`:
  its section, old and new text (only the changed words of a long text), link and what changed (`text`, `name`,
  `image`, `rotation`, `type`, `appearance`); beyond 100 entries `nodeChangesOmitted` counts the rest. It only counted
  them before.
- `diff_board` names each changed table cell in the text output with its table, row and column (counted from 1) and
  the labels of its row and column; `tableCellChanges` entries get row and column from cell IDs like `get_board_context`
  when the snapshot stores none, and the new optional `tableName`, `rowLabel` and `columnLabel`. Before, cells were only
  in `tableCellChanges`, without row and column for tables read through the REST API.

## 0.10.1 — 2026-10-21

- `ingest_board` downloads the board on every call. A re-ingest skipped the download while `/meta` reported the same
  `version`, but `version` and `last_touched_at` there follow an edit only minutes later, with Figma's next autosave,
  so re-ingests could return an outdated board. `file_metadata:read` is no longer needed.
- Renders for image interpretation show the current board. They were requested for the file's `version`, so Figma
  rendered its last autosave: edited drawings looked outdated and nodes added since were missing.
- A request to `openrouter/free` or `openrouter/auto` that fails with an error that moves on to the next model (not a
  429 or a cancellation) is sent once more while at least a second of the deadline is left: the router picks a model per
  request, and the free Nemotron often fails with HTTP 404 from its only provider. `diagnose_llm_config` lists both
  attempts and calls a check that passed on the second one a retry, not a fallback.
- Without `LLM_FAST_TEXT_MODELS`, `diagnose_llm_config`'s `fast_text_json` check uses the text models, including
  `LLM_TEXT_MODEL`, as documented; it used the preset's list, so a custom `LLM_TEXT_MODELS` was not checked there.

## 0.10.0 — 2026-10-21

- Clusters without a model label that hold at least two texts in one section are named after it: the section name if
  it holds no other cluster, else "<section>: <first text>". Other clusters take their first text in reading order
  instead of member order. Labels are recomputed on every ingest, so existing snapshots get them with the next one;
  phases from `docStructureHint` and `customPhases` follow the new labels.
- An arrow's text is no longer a loose excerpt; it stays the arrow's label in `connections`, relations and
  `diff_board`. `get_board_context` shows an arrow once one of its ends, or a section, frame or group around one, is
  on the page, never an arrow to a page, and names an end that is no excerpt of the page with its short text (a section
  with its name) in the new optional `fromText` or `toText`. `answer_from_board` keeps only arrows between its
  excerpts.
- `forceFullIngest` downloads and extracts the board again but keeps the image interpretations of unchanged clusters
  in every mode; pending clusters continue as on any ingest, with provider cooldowns. Model and prompt changes are
  detected without it. Before, a forced `balanced` or `max_quality` ingest discarded them and started over.
- `diagnose_llm_config` lists the models each check tried in the new optional `attempts` (model, ok and the provider's
  message or error). A failed check names every model with its error, and the summary names checks that passed only
  with a later candidate, with the model that failed.
- The `student-free` preset sends text to `openrouter/free` only, like images: the free Nemotron 3 Super answered for
  hours with HTTP 404 from its only provider, which cost every text request an extra request. Image interpretations
  now depend only on the vision models, `LLM_BASE_URL`, `LLM_PROVIDER_REQUIRE_PARAMETERS` and the extraction and prompt
  versions, so changing text models keeps them. After this update, the next ingest interprets images once again.
- `get_board_context` returns `nextCursor` as `<page>.<offset>.<snapshot prefix>.<checksum>`, about 35 characters of
  digits, a–f and dots instead of over 300. A changed character or a cursor sent with other settings gives an error that
  names what to send; the cursor still reads its snapshot after later ingests, and older cursors are accepted.
- The `ingest_board` summary says whether the board content changed since the previous ingest of the same extraction
  version and, if so, names `diff_board` with the board's ID as the next step.

## 0.9.1 — 2026-10-20

- `ingest_board` sends every image to the vision model with at most 1,024 px on the longest side. Larger PNG and JPEG
  originals, now downloaded up to 8 MiB, and larger renders are scaled down on a worker thread and sent as JPEG. The
  EXIF orientation of a JPEG is applied, so a turned phone photo arrives upright, also within 1,024 px. GIF and WebP
  above 1,024 px, originals above 40 megapixels and malformed ones are rendered instead. In 0.9.0, full-size originals
  pushed image requests past the 40-second vision budget.
- Text, answer and image requests move to the next configured model after HTTP 404 or 410 or OpenRouter's "Provider
  returned error"; 400, 401, 402, 403 and 422 without these signs still stop. A failed `diagnose_llm_config` check
  names the provider's message (message, code and provider name, at most 200 characters); other tools still leave
  provider details out.

## 0.9.0 — 2026-10-20

- `get_board_context` with several `nodeIds`, at least one of them a page, section, frame or group, shows
  every requested ID on every page: the IDs take turns in request order, each excerpt counts for its own or
  the innermost requested ID, and the first page names each ID with its excerpts. The cursor now depends on
  the order of `nodeIds`. A table of which a page shows only some rows names the request for all of them.
- `get_board_context` reads every excerpt outside sections with the new input `outsideSections: true`,
  cluster by cluster in reading order. The largest sections in the `ingest_board` summary and on the first
  page skip sections inside an already named one and state how many excerpts they hold together; both
  name the excerpts outside sections and how to read them.
- `ingest_board` sends image clusters to the vision model as original images from one Figma image fills
  request (Tier 2) per ingest instead of renders (Tier 1): up to 6 image nodes per cluster, the largest first,
  3.75 MiB each and 8 MiB per request. Renders remain for drawings without an image and for single images
  without a usable original. `qualityReport.figmaRequests` counts the image fills and render requests.
- `ingest_board` with `forceFullIngest` redoes only the image interpretation of its `ingestMode` and keeps the
  others for unchanged clusters: a forced `max_speed` ingest no longer discards earlier interpretations.
- `ingest_board` takes `focusNodeIds`: the image clusters inside these pages, sections, frames, groups or nodes
  are interpreted first, in list order, and `qualityReport.focus` and the summary report their progress.
  The summary states the Figma image requests with their tier.

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
  rows of a table as one block. Tables whose rows cannot be derived keep `table_cell` excerpts. Unfocused
  pages keep the rows of a table together, and a page that continues a table repeats its first row.

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
