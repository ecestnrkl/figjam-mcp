# Sample run (mock data)

This walks through calling all three tools against the current scaffold.
All responses below are mock data — no real Figma file is fetched yet.

## 1. ingest_board

Request:

```json
{
  "figmaFileUrl": "https://www.figma.com/file/abc123/My-Workshop-Board",
  "docStructureHint": "double_diamond"
}
```

Response (`structuredContent`):

```json
{
  "boardId": "board_3f2a1c9e-....",
  "clusterCount": 4,
  "summary": "Mock ingest of \"https://www.figma.com/file/abc123/My-Workshop-Board\" using docStructureHint=\"double_diamond\". Found 4 placeholder clusters (real ingestion pipeline not implemented yet)."
}
```

## 2. get_board_context

Request:

```json
{
  "boardId": "board_3f2a1c9e-....",
  "topic": "user research"
}
```

Response (`structuredContent`):

```json
{
  "contextText": "Mock context for board \"board_3f2a1c9e-....\" (topic: \"user research\"). This board has 4 placeholder clusters spanning discovery notes, problem framing, ideation sketches, and next steps.",
  "clusters": [
    { "label": "Problem framing", "phase": "define", "summary": "...", "sourceNodeIds": ["1:23", "1:24", "1:25"] },
    { "label": "Ideation sketches", "phase": "develop", "summary": "...", "sourceNodeIds": ["2:10", "2:11"] },
    { "label": "User research notes", "phase": "discover", "summary": "...", "sourceNodeIds": ["3:5", "3:6", "3:7"] },
    { "label": "Next steps", "phase": "deliver", "summary": "...", "sourceNodeIds": ["4:1"] }
  ]
}
```

## 3. answer_from_board

Request:

```json
{
  "boardId": "board_3f2a1c9e-....",
  "question": "What did users struggle with most?"
}
```

Response (`structuredContent`):

```json
{
  "answer": "Mock answer for board \"board_3f2a1c9e-....\" to the question \"What did users struggle with most?\". (Real answer synthesis not implemented yet.)",
  "citedClusters": ["Problem framing", "Ideation sketches"]
}
```
