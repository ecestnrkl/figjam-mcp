# Sample run

This walks through calling the main tools against a real FigJam board
(responses shortened). Note that `boardId` is simply the Figma file key —
re-ingesting the same file refreshes its cache entry.

## 0. diagnose_llm_config

Request:

```json
{}
```

Response (`structuredContent`):

```json
{
  "ok": true,
  "preset": "student-free",
  "visionModels": ["google/gemma-4-26b-a4b-it:free", "openrouter/free"],
  "textModels": [
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "nvidia/nemotron-nano-9b-v2:free",
    "openrouter/free"
  ],
  "summary": "LLM configuration OK (student-free)."
}
```

## 1. ingest_board

Request:

```json
{
  "figmaFileUrl": "https://www.figma.com/board/AbC123XyZ456/My-Workshop-Board",
  "docStructureHint": "double_diamond",
  "ingestMode": "balanced"
}
```

Response (`structuredContent`):

```json
{
  "boardId": "AbC123XyZ456",
  "clusterCount": 4,
  "summary": "Ingested board AbC123XyZ456: 4 clusters - \"User research notes\", \"Problem framing\", \"Ideation sketches\", \"Next steps\" (docStructureHint=double_diamond).",
  "qualityReport": {
    "modelsUsed": ["google/gemma-4-26b-a4b-it:free"],
    "cachedClusters": 0,
    "deterministicClusters": 2,
    "visionClusters": 2,
    "fallbackCount": 0
  }
}
```

## 2. get_board_context

Request:

```json
{
  "boardId": "AbC123XyZ456",
  "topic": "user research"
}
```

Response (`structuredContent`):

```json
{
  "contextText": "FigJam board AbC123XyZ456 — 1 of 4 clusters (topic: user research):\n\n## User research notes [discover]\nSticky notes with quotes and observations from six user interviews. Two embedded screenshots show survey results as bar charts of study habits. Recurring themes are unclear requirements and late feedback.",
  "clusters": [
    {
      "label": "User research notes",
      "phase": "discover",
      "summary": "Sticky notes with quotes and observations from six user interviews. …",
      "sourceNodeIds": ["3:5", "3:6", "3:7"]
    }
  ]
}
```

## 3. answer_from_board

Request:

```json
{
  "boardId": "AbC123XyZ456",
  "question": "What did users struggle with most?"
}
```

Response (`structuredContent`):

```json
{
  "answer": "Users struggled most with unclear requirements and feedback arriving too late to act on.",
  "citedClusters": ["User research notes", "Problem framing"]
}
```
