# Security policy

Security fixes target the latest release on the current development line.
Use supported Node.js LTS versions and apply dependency updates promptly.

## Reporting

Use GitHub's **Report a vulnerability** option on the repository Security tab
when private reporting is enabled. If that option is unavailable, open an issue
requesting a private reporting channel without including exploit details or
secrets. Do not attach Figma tokens, provider keys, private board content or cache
files to public issues. There is no guaranteed response-time SLA.

## Data boundary

This is a local stdio server intended for one user's trusted MCP client. It does
not expose an HTTP endpoint or implement multi-user access control. Figma tokens
belong in the environment. Board text/screenshots and questions can be sent to the
configured LLM provider; provider retention and costs depend on that provider.
Use max_speed ingest and get_board_context to avoid model calls.

Local snapshots contain board content and are stored in a private per-user cache.
Only connect clients trusted to read that data. Re-ingest after upgrading from
legacy cache formats. Stop the server before removing its cache directory.
Board content is untrusted input; source citations and prompt boundaries reduce
risk but do not make model output authoritative. Review cited source nodes.
