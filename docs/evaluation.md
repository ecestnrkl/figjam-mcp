# Evaluation

How figjam-context-mcp is checked and what the results show. Answer quality is
not a release gate; the model checks below are smoke tests.

## Retrieval and change detection (offline)

`npm run eval:retrieval` runs 20 synthetic board cases without provider calls.
CI runs it on every push (Linux, Node 24).

| Check | Result |
| --- | --- |
| Expected source ranked first | 18/18 |
| Correct empty result for an unrelated topic | 2/2 |
| Expected board changes found by `diff_board` | 20/20 |
| Changes named in the text output | 20/20 |

The corpus is small and synthetic. It measures ranking, source traceability and
diffs, not answers on real boards.

## Model answers (smoke test)

`npm run eval:retrieval -- --with-llm --grounding-only` sends five synthetic
status questions (unknown, confirmed, explicitly negative, proposed,
conflicting) to the configured provider. The answers need human review: a valid
citation does not make a conclusion correct.

With free models, the status decisions in the checked runs were mostly correct,
for example 5/5 and 24/25. Most failures were provider timeouts. Free models
change often, so these runs are smoke tests, not a benchmark.

On 2026-10-18, `diagnose_llm_config` with the default preset of that time passed
all three checks in 6 s: text on `nvidia/nemotron-3-super-120b-a12b:free`, image
through `openrouter/free`. With its earlier 256-token cap the image check had
failed. Since 0.10.0 the preset sends text to `openrouter/free` only.

## Real board (max_speed)

A private research board with 5,024 Figma nodes, 106 tables and 2,667 table
cells, ingested twice with `ingestMode: "max_speed"` (no LLM calls) through the
Inspector CLI on macOS with Node 24:

| Run | Time | Clusters | Relations | Reused clusters |
| --- | ---: | ---: | ---: | ---: |
| First ingest | 6.7 s | 297 | 10 | 0 |
| Unchanged re-ingest | 2.6 s | 297 | 10 | 297 |

Times are wall-clock and include about 2 s to start the Inspector and the
server. Three arrows anchored to the page canvas did not become connections.

## Known limitations

- Vision gets 40 s per ingest by default; large boards need several ingests for
  full image interpretation. `max_speed` skips vision.
- A cancelled ingest, for example after a client timeout, saves nothing.
- Few free models accept images with structured outputs, so free image
  interpretation is the least reliable part of the default preset.
- Search is lexical (BM25 over original text, table rows and names); synonyms
  without shared words do not match.
- Citations show where an answer comes from, not that its conclusion is right.
- In the Inspector web UI with Safari, a finished ingest was once displayed
  late; the Inspector CLI was not affected.
