# Contributing

Use Node.js 22.12+ (22 or 24 LTS recommended). Clone the repository and run
`npm ci`. Make changes on a branch and include a regression test for changed
behavior. Tests use synthetic board data; never commit tokens, private boards,
screenshots or local cache files.

Before a pull request, run `npm run check`, `npm run package:smoke` and
`npm run security:check`. The package smoke test downloads production dependencies
from npm and exercises the installed CLI. No Figma or LLM credentials are needed.
CI runs the same checks on Linux, macOS and Windows with Node 22 and 24.

Describe the concrete problem, behavior change, compatibility impact and how it
was verified. Keep the five public tool contracts compatible; new response fields
should be additive. Cache format changes must preserve old files and explicitly
require re-ingest when old data cannot be read safely.

Use the issue templates for reproducible bugs and feature proposals. Discuss
large API or transport changes before implementing them. Follow SECURITY.md for
sensitive reports. Review automated dependency PRs regularly; changes are not
automatically merged or published.

## Releases

Maintain CHANGELOG.md and matching versions in package.json, package-lock.json
and server.json. The Release candidate workflow creates a tested tarball for
review; it does not publish or create a GitHub release. A maintainer can publish
an approved tarball, create a matching tag/release and then submit server.json
to the MCP Registry. Confirm package ownership and registry availability first.
Request a fresh Glama inspection so all five tools are visible after release.
