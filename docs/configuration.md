# Configuration

Set variables in the `env` block of your MCP client. When the server starts in a
directory that contains a `.env` file, it loads that file as well; values from
the client win. Restart the server after a change.

## Environment variables

### Credentials and provider

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIGMA_ACCESS_TOKEN` | required for `ingest_board` | Figma personal access token with `file_content:read`. Add `file_metadata:read` so re-ingests of an unchanged board skip the download. |
| `LLM_BASE_URL` | none | OpenAI-compatible endpoint, for example `https://openrouter.ai/api/v1`. Required for every LLM call. |
| `LLM_API_KEY` | none | Provider key. Required for every LLM call. |

### Models

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_MODEL_PRESET` | `student-free` | Default model lists; `student-free` is the only preset. |
| `LLM_TEXT_MODELS` | `nvidia/nemotron-3-super-120b-a12b:free,openrouter/free` | Candidates for `answer_from_board`, tried in order. |
| `LLM_VISION_MODELS` | `openrouter/free` | Candidates for image interpretation. |
| `LLM_FAST_TEXT_MODELS` | same as `LLM_TEXT_MODELS` | Used only by `diagnose_llm_config`. |
| `LLM_TEXT_MODEL`, `LLM_VISION_MODEL` | none | Legacy: one model placed in front of the list. |
| `LLM_PROVIDER_REQUIRE_PARAMETERS` | `true` | Only when `LLM_BASE_URL` points to `openrouter.ai`: sends `provider.require_parameters` with JSON requests, so only endpoints that support structured output are used. `false` turns it off. |
| `LLM_ANSWER_REASONING_EFFORT` | unset | `none`, `low`, `medium` or `high` for `answer_from_board` only. Unset keeps the model's default. |

A request moves to the next candidate after a rate limit, server error, timeout,
invalid JSON or an unavailable model. Changing any model setting or
`LLM_BASE_URL` makes the next ingest interpret images again; source snapshots stay.

### Timeouts and retries

| Variable | Default | Purpose |
| --- | --- | --- |
| `INGEST_BOARD_VISION_BUDGET_MS` | `40000` | Time for the vision phase of one ingest. `0` starts no vision work; use `max_speed` for text-only ingests. |
| `INGEST_BOARD_MIN_VISION_SLOT_MS` | `10000` | A cluster's render or model step starts only if this much budget is left. |
| `FIGMA_FILE_REQUEST_TIMEOUT_MS` | `60000` | Download of the board's file tree. |
| `FIGMA_REQUEST_TIMEOUT_MS` | `15000` | Each other Figma request: version check, image render, image download. |
| `LLM_REQUEST_TIMEOUT_MS` | `20000` | Each text request (answers, text diagnostics). |
| `LLM_VISION_REQUEST_TIMEOUT_MS` | `60000` | Each image request. Without it, an explicit `LLM_REQUEST_TIMEOUT_MS` applies. |
| `LLM_RATE_LIMIT_RETRIES` | `1` | Retries of a request after HTTP 429. |
| `LLM_RATE_LIMIT_MAX_BACKOFF_MS` | `5000` | Longest wait before such a retry, including `Retry-After`. |
| `LLM_SDK_MAX_RETRIES` | `0` | Automatic retries inside the OpenAI SDK. |

### Output and prompt budgets

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_ANSWER_MAX_OUTPUT_TOKENS` | `2048` | Answer tokens, including reasoning tokens. The text checks of `diagnose_llm_config` use the same budget. |
| `LLM_VISION_MAX_OUTPUT_TOKENS` | `4096` | Tokens per image request, including reasoning tokens; also used by the image check of `diagnose_llm_config`. Minimum 256. |
| `LLM_ANSWER_TOP_K` | `6` | Excerpts retrieved per question; at most 30. |
| `LLM_ANSWER_PROMPT_MAX_CHARS` | `24000` | Prompt size for answers; 4096 to 24000. |
| `LLM_MAX_OUTPUT_TOKENS` | `14096` | Fallback for calls without their own limit; every current tool sets one. |

### Concurrency and cache

| Variable | Default | Purpose |
| --- | --- | --- |
| `INGEST_BOARD_VISION_CONCURRENCY` | `3` | Clusters interpreted in parallel. |
| `FIGMA_SCREENSHOT_DOWNLOAD_CONCURRENCY` | `3` | Parallel image downloads per cluster. |
| `FIGJAM_MCP_MEMORY_CACHE_MAX_BOARDS` | `10` | Boards kept in memory; others are reloaded from disk. |
| `FIGJAM_MCP_CACHE_DIR` | OS cache directory | Cache root. Use an absolute, dedicated directory. |

Invalid numbers fail with an error that names the variable and its minimum.

## Ingest modes

| `ingestMode` | Vision is used for | LLM key needed |
| --- | --- | --- |
| `balanced` (default) | Clusters with images or less than 40 characters of text | Yes, for those clusters |
| `max_speed` | No cluster | No |
| `max_quality` | Every cluster | Yes |

Clusters without vision keep a summary built from their extracted text.
`forceFullIngest: true` re-downloads the board and skips all reuse; the vision
budget still applies.

## Timeouts

Many MCP clients cancel a tool call after the MCP SDK's default request timeout
of 60 seconds. A cancelled ingest saves nothing. An ingest consists of the Figma
download, clustering, the vision phase and saving; only the vision phase has a
budget. With the 40-second default, 20 seconds of a 60-second client timeout
remain for everything else. For very large boards or a slow Figma API, see
[troubleshooting](troubleshooting.md#client-timeouts).

`diagnose_llm_config` runs its three checks in parallel and stops each after 45
seconds, so it answers within a 60-second client timeout even if a provider hangs.

Vision requests still running at the deadline are cancelled. Clusters that did
not finish keep their extracted text, are marked incomplete
(`qualityReport.fallbackReasons`) and continue on the next ingest; clusters
deferred by the budget go before clusters that failed. Raise
`INGEST_BOARD_VISION_BUDGET_MS` only if your client's timeout is longer.

## Limits

- Figma file: 64 MiB, 100,000 nodes, 1,024 nesting levels.
- Images: 8 MiB each and 64 MiB per ingest; up to 6 screenshots per cluster.
- Vision text per cluster: 160 nodes and 24,000 characters (300 per node).
  Groups of more than 250 nodes are split before vision.
- `get_board_context`: `limit` 20 (max 100) excerpts, `maxChars` 12,000 (max
  24,000), up to 50 `nodeIds`, at most 128 KiB per result.
- `answer_from_board`: 6 excerpts (20 for overview questions) plus direct
  neighbours, within 24,000 prompt characters.
- History: 20 snapshots per board for `diff_board`.

## Cache, migration and lock

| Platform | Default cache root |
| --- | --- |
| macOS | `~/Library/Caches/figjam-context-mcp` |
| Windows | `%LOCALAPPDATA%\figjam-context-mcp` |
| Linux | `$XDG_CACHE_HOME/figjam-context-mcp` or `~/.cache/figjam-context-mcp` |

- Files live in the `v4/` subdirectory of the root. On Unix the root is
  owner-only; on Windows the user profile's access rules apply.
- The cache holds board text, node metadata, interpretations and up to 20
  snapshots per board; screenshots and tokens are never stored. A restarted
  server reads the cache, so no re-ingest is needed.
- One atomic manifest replacement publishes a snapshot, its interpretations and
  the history together.
- Legacy v3 caches (`.cache/figjam-mcp/` in the server's working directory, or
  `FIGJAM_MCP_CACHE_DIR` if set) are kept unchanged and not converted. Run
  `ingest_board` once per board after upgrading.
- Writers take `v4/.write-lock`. A second writer waits up to 10 seconds; if the
  lock is still held, the ingest result carries a `persistenceWarning` and the
  snapshot lives only in memory. If a server crashed while writing, stop every
  server that uses this cache, delete only `v4/.write-lock` and restart. Saved
  snapshots stay readable.
- To delete all data, stop the server and remove the cache root. Data already
  sent to an LLM provider is not affected.
