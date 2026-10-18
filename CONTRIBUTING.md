# Contributing

Use Node.js 22.12+ (22 or 24 LTS recommended). Clone the repository and run
`npm ci`. Make changes on a branch and include a regression test for changed
behavior. Tests use synthetic board data; never commit tokens, private boards,
screenshots or local cache files.

Before a pull request, run `npm run check`, `npm run package:smoke` and
`npm run security:check`. The package smoke test downloads production dependencies
from npm and exercises the installed CLI. No Figma or LLM credentials are needed.
CI runs the same checks on Linux, macOS and Windows with Node 22 and 24.
It also verifies the package on exactly Node 22.12.0 and evaluates the synthetic
retrieval/change fixtures offline on Linux/Node 24. Provider evaluations remain
explicit opt-in and require separate review of the generated answers.

`python3 scripts/generate-pipeline-gif.py` regenerates `docs/pipeline.gif`
(needs Python 3 with Pillow and the DejaVu fonts).

Describe the concrete problem, behavior change, compatibility impact and how it
was verified. Keep the five public tool contracts compatible; new response fields
should be additive. Cache format changes must preserve old files and explicitly
require re-ingest when old data cannot be read safely.

Use the issue templates for reproducible bugs and feature proposals. Discuss
large API or transport changes before implementing them. Follow SECURITY.md for
sensitive reports. Review automated dependency PRs regularly; changes are not
automatically merged or published.

## Releasing

1. In a pull request, set the new version in `package.json`, `package-lock.json`
   (`npm version <x.y.z> --no-git-tag-version`) and both `version` fields of
   `server.json`, and date the CHANGELOG section (`## x.y.z — YYYY-MM-DD`).
2. Merge the pull request once CI is green.
3. Tag the merge commit on `main` and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The Release workflow checks that the tag, `package.json`, `server.json` and
CHANGELOG agree. It then runs the audit and the long package smoke test, and
publishes the tested tarball to npm with provenance through trusted publishing,
so no npm token is needed. Next it publishes `server.json` to the MCP Registry
and creates the GitHub release from the CHANGELOG section. Request a fresh
Glama inspection afterwards.

To keep a tested tarball locally, run
`npm run package:smoke -- --long --artifact-dir /absolute/path/to/new-directory`.
