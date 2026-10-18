# AGENTS.md

Instructions for coding agents working on this repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Context

figjam-context-mcp is a local stdio MCP server (TypeScript, Node.js 22.12+) that turns FigJam boards
into source-cited context for LLMs. Five tools: `ingest_board`, `get_board_context`,
`answer_from_board`, `diff_board`, `diagnose_llm_config`. Current plan: [ROADMAP.md](ROADMAP.md).

## Working rules

1. **Do the task, nothing more.** Put other findings under "Follow-ups" in the PR description.
2. **Compatibility:** tool names, input schemas and required output fields are a public contract.
   Change them only when the task says so.
3. **Done means:** `npm run check` and `npm run package:smoke` pass, CI is green on all jobs,
   new behaviour has tests, user-visible changes have one line in CHANGELOG.md.
4. **LLM answer quality is not a gate.** Never block a change or a release on how a free model
   answers. No multi-round acceptance campaigns, request ledgers, checksum reports or per-request
   approval budgets. A live provider check is a smoke test: synthetic data, at most 10 requests,
   result summarized in the PR.
5. **Privacy:** never send content of a real board to an LLM provider unless the task explicitly
   allows it. Never commit `.env`, tokens, board data or `.cache/`, and never put real board names,
   URLs or content into commits, PRs or docs.
6. **Docs:** English and concise. Evidence belongs in the PR description, not in new files.
   Do not add review or report documents. Update README/docs only where behaviour changed.
7. **Git:** feature branch, Conventional Commits, one focused PR. Do not merge, tag, publish to npm
   or update registries (MCP Registry, Glama) unless the task says so.
8. **Stop instead of looping:** if something fails twice for reasons outside the code (provider
   outage, rate limit, missing credentials), stop and report what is needed.

## Commands

- `npm run check` — typecheck, tests, build, package validation
- `npm run package:smoke` — pack, install with production dependencies only, exercise all tools
- `npm run eval:retrieval` — offline retrieval/diff evaluation, no provider calls
