# Napkin

Napkin is a shared Excalidraw canvas for agent + human collaboration.

It exposes an MCP server for agents (`mcp/`) and a browser UI (`ui/`). Chat stays in your existing channel (Slack, WhatsApp, CLI); Napkin is canvas-only.

## Repository Layout

- `mcp/` - MCP server (TypeScript, Node.js)
- `ui/` - Browser app (React + Vite + Excalidraw)
- `ARCHITECTURE.md` - Detailed architecture and protocol docs

## Quick Start

### 1) Start the MCP server

```bash
cd mcp
npm install
npm run build
npm start
```

Defaults:
- MCP HTTP: `http://localhost:3003`
- WebSocket: `ws://localhost:3002`

### 2) Start the browser UI

```bash
cd ui
npm install
npm run dev
```

Open the Vite URL (typically `http://localhost:5173`).

## Environment Variables

Common server variables:

- `NAPKIN_TRANSPORT` (`http` or `stdio`, default `http`)
- `NAPKIN_MCP_PORT` (default `3003`)
- `MCP_WS_PORT` (default `3002`)
- `AGENT_TRIGGER_DEBOUNCE_MS` (default `3000`)
- `NAPKIN_TRIGGER_WEBHOOK` (optional global webhook URL)
- `NAPKIN_COMPACT_TRIGGERS` (`true`/`false`, default `false`)
- `NAPKIN_TRIGGER_INCLUDE_CANVAS` (`true`/`false`, default `false`)
- `NAPKIN_SESSION_TTL_MS` (default `7200000`)
- `NAPKIN_EXPORT_DIR` (optional base dir for relative exports)
- `ANTHROPIC_API_KEY` (required for vision tools only)

See `ARCHITECTURE.md` for full details.

## Breaking Changes (Recent)

- `patch_canvas` now accepts an array/object payload directly (no JSON-encoded string argument).
- `update_canvas` now accepts an array/object payload directly (no JSON-encoded string argument).
- Trigger routing and debounce are session-scoped (fan-out per active session).

## Development Checks

```bash
cd mcp && npm run build
cd ui && npm run build
```

## Security

Please review `SECURITY.md` for reporting guidance.
