# Security Policy

## Reporting a Vulnerability

Please do not open public issues for security vulnerabilities.

Instead, report privately with:

- A clear description of the issue
- Affected component(s) and version/commit
- Reproduction steps or proof of concept
- Impact assessment

Until a dedicated security contact is published, use a private channel with the maintainers.

## Scope

This project includes:

- MCP server (`mcp/`)
- Browser UI (`ui/`)
- Webhook and session routing behavior

## Sensitive Data Guidance

- Never commit API keys, tokens, or local secrets.
- Keep `.env` and local runtime logs out of version control.
