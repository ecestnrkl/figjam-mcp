# Troubleshooting

## Client timeouts

MCP clients built on the official SDK wait 60 seconds for a tool call by default.
Progress notifications do not extend that wait unless the client enables
`resetTimeoutOnProgress`. After the timeout the client reports
`MCP error -32001: Request timed out` and sends a cancellation; a cancelled
ingest saves nothing.

The vision phase stops after 40 seconds by default, which leaves 20 seconds of
a 60-second timeout for the download, clustering and saving. If `ingest_board`
still times out:

1. Run it with `ingestMode: "max_speed"`. It makes no LLM calls and stores the
   full text, tables and arrows.
2. Raise the tool timeout and `INGEST_BOARD_VISION_BUDGET_MS` together, leaving
   about 30 seconds for the rest of the ingest (for example 300 seconds and
   `270000` ms); see the [client-specific README settings](../README.md#quick-start)
   and the VS Code Copilot-harness limitation there.
3. Lower `INGEST_BOARD_VISION_BUDGET_MS` (for example to `25000`) when the Figma
   download of a large board takes long.

Clusters that ran out of time keep their extracted text. Run `ingest_board`
again to continue the image interpretation; finished clusters are reused, also
with `forceFullIngest`. If a call timed out but was not cancelled, reconnect the
server before retrying: ingests of the same board run one after another.

## Incomplete image interpretation

`qualityReport.fallbackReasons` counts clusters without a vision summary by
cause. Original text and table rows stay searchable in every case.

| Reason | Meaning | What to do |
| --- | --- | --- |
| `time_budget` | Not started before the vision deadline | Run `ingest_board` again |
| `timeout` | A Figma or model request ran past its deadline | Run again or choose a faster model |
| `rate_limit` | Figma or the provider returned 429 | Wait until `qualityReport.nextRetryAt` |
| `config` | `LLM_BASE_URL` or `LLM_API_KEY` missing or invalid | Fix the named setting, then restart the server |
| `base_url` | `LLM_BASE_URL` leads to no reachable OpenAI-compatible API: no connection, a wrong path, or a reply that is no chat completion | Check `LLM_BASE_URL`, then run `diagnose_llm_config`; no further image requests are sent |
| `auth` | Figma or the provider rejected the credentials | Check the token, scopes and file access |
| `payment` | The model provider returned HTTP 402 (payment or more credits required) | Add credits, raise the API key's credit limit, or choose a free model |
| `invalid_reply` | The model returned no usable reply: no JSON, empty text, a refusal, a content-filter block, a reply cut off at `max_tokens` before any text, only reasoning, or a tool call | Choose another model; for a cut-off reply raise `LLM_VISION_MAX_OUTPUT_TOKENS` |
| `render_failed`, `download_budget` | Figma could not list the image fills or render the nodes, or images exceeded 64 MiB per ingest | Ingest again later or split the board |
| `model_failed` | Any other model error | Run `diagnose_llm_config` |

## MCP Inspector

`inspector.config.json` starts the local source with `requestTimeout: 180000`
and explicitly loads `.env` from the repository with Node's
`--env-file-if-exists=.env` (existing environment values win):

```bash
npx @modelcontextprotocol/inspector --config inspector.config.json
```

In Inspector 2.10, the web UI relays results through its backend, which has
its own 60-second waits; `requestTimeout` does not change them, but progress
notifications reset them. In Safari, a finished ingest was once displayed only
after a later request. If the web UI stalls after progress reports `complete`,
use the CLI, which talks to the server over stdio:

```bash
npx @modelcontextprotocol/inspector --cli --config inspector.config.json \
  --server figjam-local --method tools/call --tool-name ingest_board \
  --tool-arg figmaFileUrl=https://www.figma.com/board/FILE_KEY/Name ingestMode=max_speed
```

Do not start the server with plain `npm run dev` from an MCP client: npm prints
a banner to stdout and breaks the JSON-RPC stream. Use `npm run dev --silent` or
the config above.

## An older version is running

Without a version, `npx -y figjam-context-mcp` reuses a package already in the
npx cache and does not check for updates. Check the latest version with:

```bash
npx -y figjam-context-mcp@latest --version
```

Change `figjam-context-mcp` to `figjam-context-mcp@latest` in your client's
configuration, then restart the server in the client.

## Common errors

| Message | Fix |
| --- | --- |
| `No Figma access token — set FIGMA_ACCESS_TOKEN …` | Add the token to the client's `env` and restart the server. |
| `FIGMA_ACCESS_TOKEN contains characters that cannot be sent in an HTTP header, such as smart quotes or a line break. Copy the token again.` | Copy the token again without smart quotes, line breaks, zero-width or other non-ASCII characters. The message names `figmaAccessToken` or `LLM_API_KEY` instead when that is the source; no request is sent. |
| `INGEST_BOARD_VISION_BUDGET_MS must be an integer >= 0` | Set the named variable to a whole number in the stated range (milliseconds here, e.g. `270000`, not `270s`) and restart. Validation happens only when a tool needs the value; other tools remain usable. For boolean errors, use `true` or `false`. |
| `A .env file in the working directory is no longer loaded since 0.12.0; …` | Put the missing variables in the MCP client configuration, use VS Code `mcp.json`'s `envFile`, or set `FIGJAM_MCP_ENV_FILE` to the absolute path. This hint appears only when a working-directory `.env` exists and no explicit env file is configured. |
| `FIGJAM_MCP_ENV_FILE could not load "/path": ENOENT.` | Check the configured path and file permissions (`EACCES` means access denied). The server keeps running; missing-credential errors include this load failure. |
| `Invalid Figma URL — Expected a Figma URL like https://www.figma.com/board/<file_key>/<name> …` | Pass the board URL from the browser, e.g. `https://www.figma.com/board/FILE_KEY/Name`. |
| `Figma access denied (403). Check FIGMA_ACCESS_TOKEN: …` | The token is invalid or expired, lacks `file_content:read`, or its account cannot open the file. The same applies to 401. |
| `Figma file not found (404): …` | Check the file key; the token's account must have access. |
| `Figma API rate limit exceeded (429). …` | Figma limits requests by seat and plan; see [rate limits](https://developers.figma.com/docs/rest-api/rate-limits/). `max_speed` makes no image requests; the other modes need one image fills request per ingest and renders only for drawings without an image. |
| `Figma download exceeds the configured byte budget` | The board's file data is larger than 64 MiB. Split the board into smaller files. |
| `LLM_BASE_URL and LLM_API_KEY are not set. …` | Set `LLM_API_KEY` and `LLM_BASE_URL` in the client's `env` and restart. A Figma token does not replace the provider key. |
| `LLM_BASE_URL must be an absolute http or https URL of the API root, without /chat/completions, …` | Use the API root, for example `https://openrouter.ai/api/v1`, with the scheme and without `/chat/completions`; the SDK adds that path. The value itself is never printed. |
| `LLM request failed (HTTP 401): the model provider rejected LLM_API_KEY. …` | Check the key in the MCP client configuration and restart the server. |
| `LLM request failed (HTTP 403): the model provider denies access to the model or rejects the request, … moderation. …` | Check the key's permissions and the configured models; some providers also block a request for its content. |
| `LLM request failed: could not connect to https://host (connection refused). …` | The message names the origin of `LLM_BASE_URL` and the cause: host not found, connection refused, TLS error, host unreachable or another network error. Check the URL (scheme, host, port) and the network; no other model is tried. |
| `LLM request failed (HTTP 404): the answer was no JSON error, so LLM_BASE_URL probably points to a wrong path. …` | HTTP 404 or 405 with an HTML or text body: the URL is not an OpenAI-compatible API root. Such APIs usually end in `/v1`. One request is made; no other model is tried. |
| `LLM request failed (HTTP 404). …` | No configured model was available. A 404 or 410, or OpenRouter's "Provider returned error", moves the request to the next candidate in `LLM_TEXT_MODELS` / `LLM_VISION_MODELS`; this error means every candidate failed. `openrouter/free` and `openrouter/auto` get a second request first, which may reach another model. `diagnose_llm_config` lists every attempt in `attempts` with the provider's message. |
| `LLM request failed (HTTP 429): the model provider's request limit is reached; it accepts requests again at about 2026-11-05 00:00 UTC. …` | Free OpenRouter models allow 20 requests per minute and 50 or 1,000 per day. The time comes from `Retry-After` or, when `X-RateLimit-Remaining` is 0, from `X-RateLimit-Reset`; `qualityReport.nextRetryAt` carries it. A wait up to `LLM_RATE_LIMIT_MAX_BACKOFF_MS` is retried, a longer one fails at once. Wait, or configure your own model or key. |
| `LLM request timed out after 20s. …` | The model was too slow. Retry, choose another model or raise `LLM_REQUEST_TIMEOUT_MS` / `LLM_VISION_REQUEST_TIMEOUT_MS`. |
| `LLM (…) did not return valid JSON. The reply was cut off at max_tokens …` | A reasoning model used up its output tokens. Choose another model or raise the output limit. |
| `LLM (openrouter/free) returned an empty response (no text). …` | The free router chose a model that returned no text. Retry, or set `LLM_VISION_MODELS` / `LLM_TEXT_MODELS` to a specific model. |
| `LLM (…) declined to answer (refusal)`, `… had its reply blocked by the provider's content filter`, `… ran into max_tokens before any text arrived`, `… returned only reasoning and no text`, `… returned a tool call instead of text` | The reply is HTTP 200 but holds no text; the message names the cause. Candidates and the router repeat are tried as for any other failed reply. For a cut-off reply raise `LLM_ANSWER_MAX_OUTPUT_TOKENS` (answers) or `LLM_VISION_MAX_OUTPUT_TOKENS` (images) or use a non-reasoning model. `answer_from_board` answers with matching excerpts and the cause instead of an error. |
| `LLM request failed: LLM_BASE_URL did not return a chat completion (…). …` | The body of an HTTP 200 answer was empty, no JSON, HTML, cut off, or had no `choices`. Check that `LLM_BASE_URL` is an OpenAI-compatible API root such as `https://openrouter.ai/api/v1`. |
| `LLM request failed (HTTP 400): the model provider rejected the reasoning setting. Unset LLM_ANSWER_REASONING_EFFORT, …` | The model or provider does not accept `LLM_ANSWER_REASONING_EFFORT` (HTTP 400 or 422 naming reasoning). Unset it or choose another value or model; `diagnose_llm_config` sends the same setting with its text check. |
| `Board "…" not found — run ingest_board first.` | Ingest the board; the `boardId` is the file key from its URL. |
| `This board uses cache v3. Run ingest_board again …` | Re-ingest once after upgrading; old files are kept. |
| `Snapshot could not be saved; another server process is writing; retry ingest_board.` | Another writer held the lock for 10 seconds. Retry after it finishes; crashed local owners are recovered automatically. Any lock directory older than 10 minutes by modification time is recovered automatically, regardless of its owner information (see [configuration](configuration.md#cache-migration-and-lock)). |
| `Snapshot could not be saved; EACCES: check permissions of FIGJAM_MCP_CACHE_DIR or the cache directory, then retry ingest_board.` | Give the server write access or select a writable cache directory, then retry. `EPERM` has the same remedy. Existing directory permissions are preserved. |
| `Snapshot could not be saved; ENOSPC: the disk is full; free disk space, then retry ingest_board.` | Free space on the cache volume, then ingest again. |
| `Snapshot could not be saved; <code>: <message>; retry ingest_board.` | The warning and summary include the redacted error. Resolve that cause, then retry. A failed save remains available only in the current process. |
| `The latest cached snapshot cannot be read (damaged files); using the snapshot from <date>; run ingest_board to rebuild.` | The response uses the newest readable historical snapshot, dated in UTC. Re-ingest to capture the current board and repair damaged files. |
| `The cached snapshots of board "…" cannot be read (damaged files); run ingest_board to rebuild them.` | No saved snapshot is readable. Re-ingest the board to rebuild its cache. |
| `The requested snapshot of board "…" cannot be read (damaged files); run ingest_board to rebuild it.` | The requested `snapshotId` is damaged; no other state is substituted. Re-ingest, then start a query against the latest snapshot. |
| `A comparison snapshot of board "…" cannot be read (damaged files); run ingest_board to rebuild it.` | A snapshot needed by `diff_board` is damaged. Re-ingest to rebuild it; a readable historical snapshot is required for a comparison. |
| `The cache manifest cannot be read (damaged file); snapshot history has restarted; run ingest_board again after edits to record changes.` | The ingest saved a new baseline. Older history could not be recovered; ingest again after editing to compare changes. |
| `Cursor does not match this request or was changed. …` | Send `nextCursor` unchanged (it looks like `v2.f.2.20.1a2b3c4d5e6f.0123456789ab`) with the same `topic`, `nodeIds`, `outsideSections`, `detail`, `limit` and `maxChars`, or start without a cursor. An ingest that refined the board since also needs a new start. |
| `The snapshot of this cursor is no longer available. …` | A cursor keeps reading its snapshot after later ingests while the board's history retains it. Start without a cursor. |

Run `diagnose_llm_config` after changing model settings. Each check lists the
models it tried in `attempts`, in order, with the provider's message (at most 200
characters) for each failed one; a failed check names every model with its error,
and the summary names checks that passed only with a later candidate. Its checks
send only synthetic data; other tools leave provider messages out because they
can echo board content.
