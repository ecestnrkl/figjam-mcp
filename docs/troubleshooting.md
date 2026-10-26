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
| `config` | `LLM_BASE_URL` or `LLM_API_KEY` missing | Set both, then restart the server |
| `auth` | Figma or the provider rejected the credentials | Check the token, scopes and file access |
| `payment` | The model provider returned HTTP 402 (payment or more credits required) | Add credits, raise the API key's credit limit, or choose a free model |
| `invalid_reply` | The model returned no usable JSON | Choose another model |
| `render_failed`, `download_budget` | Figma could not list the image fills or render the nodes, or images exceeded 64 MiB per ingest | Ingest again later or split the board |
| `model_failed` | Any other model error | Run `diagnose_llm_config` |

## MCP Inspector

`inspector.config.json` starts the local source with `requestTimeout: 180000`
and loads `.env` from the repository:

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
| `Invalid Figma URL — Expected a Figma URL like https://www.figma.com/board/<file_key>/<name> …` | Pass the board URL from the browser, e.g. `https://www.figma.com/board/FILE_KEY/Name`. |
| `Figma access denied (403). Check FIGMA_ACCESS_TOKEN: …` | The token is invalid or expired, lacks `file_content:read`, or its account cannot open the file. The same applies to 401. |
| `Figma file not found (404): …` | Check the file key; the token's account must have access. |
| `Figma API rate limit exceeded (429). …` | Figma limits requests by seat and plan; see [rate limits](https://developers.figma.com/docs/rest-api/rate-limits/). `max_speed` makes no image requests; the other modes need one image fills request per ingest and renders only for drawings without an image. |
| `Figma download exceeds the configured byte budget` | The board's file data is larger than 64 MiB. Split the board into smaller files. |
| `LLM_BASE_URL and LLM_API_KEY are not set. …` | Set `LLM_API_KEY` and `LLM_BASE_URL` in the client's `env` and restart. A Figma token does not replace the provider key. |
| `LLM request failed (HTTP 404). …` | No configured model was available. A 404 or 410, or OpenRouter's "Provider returned error", moves the request to the next candidate in `LLM_TEXT_MODELS` / `LLM_VISION_MODELS`; this error means every candidate failed. `openrouter/free` and `openrouter/auto` get a second request first, which may reach another model. `diagnose_llm_config` lists every attempt in `attempts` with the provider's message. |
| `LLM request failed (HTTP 429). …` | Free OpenRouter models allow 20 requests per minute and 50 or 1,000 per day. Wait, or configure your own model. |
| `LLM request timed out after 20s. …` | The model was too slow. Retry, choose another model or raise `LLM_REQUEST_TIMEOUT_MS` / `LLM_VISION_REQUEST_TIMEOUT_MS`. |
| `LLM (…) did not return valid JSON. The reply was cut off at max_tokens …` | A reasoning model used up its output tokens. Choose another model or raise the output limit. |
| `LLM (openrouter/free) returned an empty response` | The free router chose a model that returned no text. Retry, or set `LLM_VISION_MODELS` / `LLM_TEXT_MODELS` to a specific model. |
| `Board "…" not found — run ingest_board first.` | Ingest the board; the `boardId` is the file key from its URL. |
| `This board uses cache v3. Run ingest_board again …` | Re-ingest once after upgrading; old files are kept. |
| Result contains `persistenceWarning` | The snapshot was not saved and lives only in this process. Another server held the cache lock for over 10 seconds, or the cache directory is not writable. Ingest again; after a crash, stop all servers and delete `v4/.write-lock` (see [configuration](configuration.md#cache-migration-and-lock)). |
| `Cursor does not match this request or was changed. …` | Send `nextCursor` unchanged (it looks like `v2.f.2.20.1a2b3c4d5e6f.0123456789ab`) with the same `topic`, `nodeIds`, `outsideSections`, `detail`, `limit` and `maxChars`, or start without a cursor. An ingest that refined the board since also needs a new start. |
| `The snapshot of this cursor is no longer available. …` | A cursor keeps reading its snapshot after later ingests while the board's history retains it. Start without a cursor. |

Run `diagnose_llm_config` after changing model settings. Each check lists the
models it tried in `attempts`, in order, with the provider's message (at most 200
characters) for each failed one; a failed check names every model with its error,
and the summary names checks that passed only with a later candidate. Its checks
send only synthetic data; other tools leave provider messages out because they
can echo board content.
