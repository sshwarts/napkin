# Napkin — Architecture

Napkin is a shared visual canvas for collaborative whiteboarding between agents and humans. It embeds [Excalidraw](https://excalidraw.com) in a browser and connects it to an MCP server that agents use to read, write, analyze, and animate the canvas.

The conversation stays in the agent's channel (Slack, WhatsApp, CLI). Napkin is pure canvas — no chat UI.

---

## System overview

```
                  ┌──────────────────────────┐
                  │   Agent                   │
                  │   (Perry, Claude Code,    │
                  │    any MCP client)        │
                  └─────────┬────────────────┘
                            │ MCP tools (HTTP :3003)
                            ▼
┌──────────────┐   ┌────────────────────────────────────────┐
│   Browser    │   │          Napkin MCP Server              │
│              │   │                                        │
│  Excalidraw  │◄─►│  WebSocket :3002   Canvas State Cache  │
│  component   │   │                                        │
│              │   │  Spatial Analysis   Thought Protocol    │
│  canvas-sync │   │  Vision (SVG→PNG)   Animation Engine   │
│              │   │  Session Manager    Webhook Delivery    │
│  Status dot  │   │  Export             Debounce/Triggers   │
└──────────────┘   └────────────────────────────────────────┘
                            │
                            │ webhook POST (optional)
                            ▼
                   ┌─────────────────┐
                   │ Agent's channel  │
                   │ (Slack, WhatsApp,│
                   │  A2A, webhook)   │
                   └─────────────────┘
```

**Data flow:** Canvas state is owned by the browser. On every Excalidraw change, the browser pushes the full element array to the MCP server via WebSocket. The server caches it. When an agent calls `get_canvas()`, it reads from cache. When an agent writes (`update_canvas`, `add_thought_bubble`, `animate_element`), the server updates the cache and broadcasts a patch to the browser.

---

## File structure

```
napkin/
  mcp/                          # MCP server (Node.js, TypeScript)
    src/
      index.ts                  # Entry point — HTTP/stdio transport, server instructions
      websocket.ts              # WebSocket server, canvas cache, debounce triggers
      tools.ts                  # All 25 MCP tool registrations
      intent.ts                 # Intent API (add_node, connect, move, resize, style, etc.)
      layout.ts                 # Dagre-based auto-layout
      types.ts                  # Excalidraw element types, WS protocol, spatial output types
      spatial.ts                # Spatial analysis (nodes, edges, zones, proximity)
      thought.ts                # Thought bubble creation, confirmation, dismissal
      sketch.ts                 # SVG renderer + Claude vision for element description
      animate.ts                # Property interpolation at ~30fps
      session.ts                # Session manager with auto-expire TTL
      webhook.ts                # HTTP POST trigger delivery with retry
      export.ts                 # Canvas export to .excalidraw / .svg / .png
    package.json
    tsconfig.json

  ui/                           # Browser app (React, Vite)
    src/
      App.tsx                   # Mounts Excalidraw, manages WebSocket sync
      canvas-sync.ts            # WebSocket client, reconnection, loop guard
      main.tsx                  # React entry point
      vite-env.d.ts
    index.html
    package.json
    vite.config.ts

  test/
    test-canvas.excalidraw      # Test fixture with all element types
```

---

## MCP tools (25)

### Read
| Tool | Purpose |
|------|---------|
| `get_canvas` | Spatially analyzed canvas — nodes, edges, zones, thought bubbles, sketches |
| `get_canvas_raw` | Raw Excalidraw JSON element array |
| `get_canvas_diff` | Elements changed since a given timestamp — efficient delta polling |
| `get_pending_triggers` | Poll for pending triggers (pull mode) |

### Write (Intent API)
| Tool | Purpose |
|------|---------|
| `add_node` | Add a labeled node — server handles placement. No coordinates needed |
| `connect` | Connect two nodes with an arrow — server computes binding points |
| `move` | Move element by relative offset (dx, dy). Moves bound text too |
| `resize` | Resize element. Maintains center position |
| `style` | Apply style changes (color, fill, opacity, strokeStyle) |
| `add_label` | Add floating text near an element |
| `delete_element` | Delete element and its bound text |
| `patch_canvas` | Modify existing elements with partial patches — 10-20x smaller than full updates |
| `update_canvas` | Add new elements with full definitions (use intent API for modifications) |
| `clear_canvas` | Remove all elements |

### Layout
| Tool | Purpose |
|------|---------|
| `layout` | Auto-arrange nodes/edges via Dagre (TB, LR, tree, hierarchy) |

### Thought Bubbles
| Tool | Purpose |
|------|---------|
| `add_thought_bubble` | Create a dashed purple tentative element |
| `confirm_thought_bubble` | Convert thought bubble to permanent element |
| `dismiss_thought_bubble` | Remove a thought bubble |
| `list_thought_bubbles` | List all current thought bubbles |

### Vision (requires ANTHROPIC_API_KEY)
| Tool | Purpose |
|------|---------|
| `describe_elements` | Render element(s) to PNG, send to Claude vision for description |
| `describe_sketch` | Convenience wrapper for single freehand element |

### Animation & Export
| Tool | Purpose |
|------|---------|
| `animate_element` | Smoothly interpolate position/size/opacity/color over time. Use `commit` for atomic final state |
| `export_canvas` | Save canvas to file (.excalidraw, .svg, .png). Browser-side rendering for SVG/PNG when connected |

### Sessions
| Tool | Purpose |
|------|---------|
| `start_session` | Begin a whiteboard session with channel ID, webhook URL, and optional debounce override |
| `end_session` | End a session |

---

## WebSocket protocol

All messages are JSON over WebSocket on port 3002.

**Browser → Server:**
```
{ type: "canvas_update", elements: [...], appState: {...} }  // Every Excalidraw change
{ type: "chat_message", message: "text" }                     // Injected by agent framework (not a UI element)
```

**Server → Browser:**
```
{ type: "canvas_patch", elements: [...] }    // Partial update (agent wrote something)
{ type: "canvas_replace", elements: [...] }  // Full replace (reconnect hydration)
```

On new WebSocket connection, the server immediately sends `canvas_replace` with the full cached state so the browser hydrates.

---

## Write model

Napkin has three levels of write API, from highest to lowest abstraction:

**Intent API** (recommended) — `add_node`, `connect`, `move`, `resize`, `style`, `add_label`, `delete_element`. Agent describes *what* it wants; server handles coordinates, bindings, and element construction. A 3-node diagram takes ~277 bytes across 6 calls.

**patch_canvas** — Modify existing elements with partial patches. Send `[{ id: "X", backgroundColor: "#red" }]` instead of the full 600-byte element. 10-20x payload reduction. Server merges with cached state.

**update_canvas** — Raw element replacement. Required for new elements not covered by the intent API. Agent constructs full Excalidraw element JSON. Use sparingly.

**Layout** — `layout(style)` runs Dagre on all nodes/edges and repositions them. Call after adding nodes and connections. No coordinate math needed.

Typical agent workflow: `add_node` → `connect` → `layout` → `style` tweaks via `patch_canvas`.

---

## Spatial analysis

`get_canvas()` transforms raw Excalidraw JSON into semantic structure:

- **Nodes** — rectangles, ellipses, diamonds with labels (from bound text elements)
- **Edges** — arrows with `startBinding`/`endBinding` referencing nodes
- **Zones** — large rectangles containing other elements (swim lanes). A zone labeled "Parking Lot" (case-insensitive) marks contained items with `status: parking_lot`
- **Proximity properties** — floating text near a node is attached as an inferred property with a confidence score (0–1), based on distance within a configurable grid
- **Thought bubbles** — elements with `strokeStyle: "dashed"` and `strokeColor: "#8B5CF6"`
- **Freehand sketches** — `freedraw` elements, optionally with vision-generated descriptions

No coordinates are exposed to the agent. The output is purely semantic.

---

## Thought bubble protocol

Visual style: dashed border, `#8B5CF6` (purple) stroke, `#EDE9FE` background, 60% opacity. Text prefixed with `💭`.

Lifecycle: `add_thought_bubble` → appears on canvas → human reviews → `confirm_thought_bubble` (makes permanent: solid border, full opacity, no emoji) or `dismiss_thought_bubble` (deletes).

Positioning: 50px right of the specified node, or in open space. Overlap avoidance via bounding box checks.

---

## Vision (describe_elements)

Renders any canvas element(s) to SVG server-side, converts to PNG via `sharp`, sends to Claude vision (model configurable via `NAPKIN_VISION_MODEL`). Returns a one-sentence description and creates a grouped text annotation on the canvas.

Supported element types for SVG rendering: rectangle, ellipse, diamond, text, arrow, line, freedraw. Bound text labels are automatically included.

**Known gap:** Pasted images (bitmap data stored in Excalidraw's files object) cannot be rendered server-side. Would require browser-side `exportToBlob()` — not yet implemented.

---

## Animation

`animate_element` interpolates numeric properties (`x`, `y`, `width`, `height`, `opacity`) and hex color properties (`strokeColor`, `backgroundColor`) from current values to target values over a specified duration.

Runs in the MCP server at ~30fps (33ms intervals). Each frame pushes a `canvas_patch` via WebSocket. No browser-side animation code needed. Easing: `linear`, `ease-in`, `ease-out`.

The tool blocks until the animation completes. Multiple animations on different elements run in parallel.

---

## Sessions

An agent calls `start_session({ session_id: "slack:C12345" })` when initiating a whiteboard. The `session_id` (typically the agent's chat JID or channel ID) is included in all webhook payloads, allowing the receiver to route canvas events back to the correct conversation.

Sessions auto-expire after `NAPKIN_SESSION_TTL_MS` (default 2 hours) of inactivity. No explicit close required, but `end_session` is available.

A per-session `webhook_url` can override the global `NAPKIN_TRIGGER_WEBHOOK`. A per-session `debounce_ms` can override the global debounce interval — use lower values for games/discrete interactions (e.g. 300ms), higher for drawing sessions (e.g. 3000ms).

**Persistence:** Sessions are saved to `~/.napkin/sessions.json` and restored on server restart. Debounce overrides are also restored.

**Reconnect trigger:** When a browser connects (or reconnects after a server restart), a `{ source: "reconnect" }` trigger fires via webhook to all active sessions. Agents can use this to verify their session is still active.

---

## Trigger / debounce model

The browser sends `canvas_update` on every Excalidraw `onChange`, including mid-stroke. Without a gate, agents get notified dozens of times per second.

**Three trigger sources:**

1. **Debounce** — canvas quiet for `AGENT_TRIGGER_DEBOUNCE_MS` (default 3000ms, overridable per-session) → passive trigger fires. Agent writes (`update_canvas`) do NOT restart the timer.
2. **Chat message** — `chat_message` injected by agent framework → immediate trigger, cancels pending debounce.
3. **Poll** — agent calls `get_pending_triggers` to drain queued triggers (pull mode, always available).

**Webhook delivery (push mode):** When `NAPKIN_TRIGGER_WEBHOOK` is set (or a session has a `webhook_url`), triggers are POSTed as JSON:

```json
{
  "trigger_id": "uuid",
  "session_id": "slack:C12345",
  "source": "debounce",
  "timestamp": 1234567890,
  "message": "[napkin] Canvas updated (idle)",
  "changed_element_ids": ["red-2"],
  "canvas": { ... }
}
```

The `message` field is always present (required by nanoclaw/OpenClaw webhook receivers). For debounce triggers without a human message, it defaults to `"[napkin] Canvas updated (idle)"`.

`changed_element_ids` lists only the elements that changed since the last trigger. `changed_elements` contains the full element data for those IDs — the agent can act immediately without a `get_canvas_diff` round-trip.

The `canvas` field is included when `NAPKIN_TRIGGER_INCLUDE_CANVAS=true`. Retry: up to 2 retries with exponential backoff (1s, 2s).

**Echo suppression:** Agent writes (`update_canvas`, `animate_element`) do not trigger webhooks. The server tracks which element IDs were written via MCP and suppresses browser echoes of those writes for 500ms. Only genuine human-originated canvas changes fire triggers.

---

## Configuration

All configuration is via environment variables. Nothing is required except `ANTHROPIC_API_KEY` (for vision tools).

| Variable | Default | Purpose |
|----------|---------|---------|
| `NAPKIN_TRANSPORT` | `http` | MCP transport: `http` or `stdio` |
| `NAPKIN_MCP_PORT` | `3003` | HTTP MCP server port |
| `MCP_WS_PORT` | `3002` | WebSocket server port (browser sync) |
| `ANTHROPIC_API_KEY` | — | API key for Claude vision (describe_elements) |
| `NAPKIN_VISION_MODEL` | `claude-haiku-4-5-20251001` | Vision model for element description |
| `NAPKIN_VISION_MAX_TOKENS` | `200` | Max tokens for vision response |
| `AGENT_TRIGGER_DEBOUNCE_MS` | `3000` | Quiet period before passive trigger (0 = disabled) |
| `GRID_CELL_SIZE` | `200` | Spatial analysis grid cell size (px) |
| `PROXIMITY_CONFIDENCE_THRESHOLD` | `0.75` | Below = inferred, above = direct annotation |
| `NAPKIN_TRIGGER_WEBHOOK` | — | URL to POST triggers to (unset = pull-only) |
| `NAPKIN_TRIGGER_INCLUDE_CANVAS` | `false` | Include structured canvas in webhook payload |
| `NAPKIN_SESSION_TTL_MS` | `7200000` | Session auto-expire after inactivity (ms) |
| `NAPKIN_SESSION_PATH` | `~/.napkin/sessions.json` | Session persistence file path |
| `NAPKIN_EXPORT_DIR` | — | Base directory for relative export paths (e.g. `/Users/scotts/Perry/napkin`) |
| `VITE_MCP_WS_URL` | `ws://localhost:3002` | Browser WebSocket URL (Vite env var) |

---

## Deployment

Runs as a macOS LaunchAgent (`com.napkin.mcp`). The MCP server and WebSocket server are a single Node.js process.

```bash
# Build
cd napkin/mcp && npm run build

# Reload
launchctl unload ~/Library/LaunchAgents/com.napkin.mcp.plist
launchctl load ~/Library/LaunchAgents/com.napkin.mcp.plist

# Logs
tail -f ~/Library/Logs/napkin-mcp.log

# Start the browser UI (development)
cd napkin/ui && npm run dev
```

**Agent configuration:**

Claude Code (`~/.claude.json`):
```json
{
  "napkin": {
    "type": "http",
    "url": "http://localhost:3003"
  }
}
```

Perry / container agents (nanoclaw `container-runner.ts`):
```
NAPKIN_MCP_HOST=192.168.64.1  →  http://192.168.64.1:3003
```

---

## Port allocations

| Port | Service |
|------|---------|
| 3001 | Nanoclaw credential proxy (DO NOT USE) |
| 3002 | Napkin WebSocket (browser ↔ server) |
| 3003 | Napkin MCP HTTP (agent ↔ server) |
| 3200 | NanoClaw webhook channel (inbound webhooks) |
| 4357 | AMP MCP HTTP |
| 5173+ | Vite dev server (browser UI) |

---

## Webhook integration with agent frameworks

Napkin's webhook delivers trigger events as a plain HTTP POST with a `message` field. This is compatible with:

- **NanoClaw** — webhook channel on port 3200 (`POST /webhook`). When the payload includes `session_id` matching a registered channel JID (e.g. `slack:D0AGREPG84R`), the message routes directly into that conversation. No `WEBHOOK_LINKED_JID` needed for session-based routing.
- **OpenClaw** — `POST /hooks/wake` with `{ "text": "...", "mode": "now" }`. Napkin's `message` field maps to OpenClaw's `text` field (consumer adapts).
- **Any HTTP server** — Flask, Lambda, Express. The payload is self-contained JSON.

### End-to-end flow (example: Slack)

1. Human messages Perry on Slack: "let's whiteboard the auth flow"
2. Perry calls `start_session({ session_id: "slack:D0AGREPG84R", webhook_url: "http://localhost:3200/webhook" })`
3. Human draws on the canvas at `localhost:5173`
4. Canvas goes quiet → debounce fires → Napkin POSTs to `:3200/webhook`:
   ```json
   { "trigger_id": "uuid", "session_id": "slack:D0AGREPG84R",
     "source": "debounce", "message": "[napkin] Canvas updated (idle)" }
   ```
5. NanoClaw webhook channel receives it, sees `session_id` matches the Slack DM JID, injects the message into that conversation
6. Perry wakes up, calls `get_canvas()`, reasons about the diagram, responds on Slack
7. Perry calls `add_thought_bubble("Should this connect to the auth service?", "auth-node")`  → appears on the canvas

The webhook channel works for *any* originating channel — Slack, WhatsApp, Siri — because `session_id` carries the routing context. No static `WEBHOOK_LINKED_JID` config needed.

### NanoClaw webhook channel configuration

```bash
# In nanoclaw .env — only WEBHOOK_PORT is required
WEBHOOK_PORT=3200
# WEBHOOK_LINKED_JID is optional — only needed for non-session-routed webhooks
```

Port 3200 is registered automatically. The webhook channel starts even without `WEBHOOK_LINKED_JID` and routes based on `session_id` in the payload.

---

## Agent instructions

The MCP server sends instructions to agents on `initialize` (the `instructions` field in the server info response). These cover tool usage, sessions, triggers, and deltas. However, **the webhook URL is framework-specific** — Napkin can't tell the agent where to send triggers.

Each agent framework must tell its agents the webhook URL in its own instructions:

**NanoClaw (Perry):** Add to the group's `CLAUDE.md`:
```
start_session({
  session_id: "<NANOCLAW_CHAT_JID env var>",
  webhook_url: "http://192.168.64.1:3200/webhook"
})
```
The host is at `192.168.64.1` from inside containers. Port 3200 is the nanoclaw webhook channel.

**OpenClaw:** Agents would use their framework's hook endpoint:
```
start_session({
  session_id: "<channel-id>",
  webhook_url: "http://127.0.0.1:18789/hooks/wake"
})
```

**Claude Code (local):** No webhook needed — Claude Code can poll `get_pending_triggers()` directly since it's interactive. Or set `NAPKIN_TRIGGER_WEBHOOK` in the plist for push delivery to a local endpoint.

The pattern: Napkin's server instructions teach *what* to do. The agent's own instructions teach *where* to route.

### Recommended agent instructions template

Add this (adapted for your framework) to your agent's instructions:

```
## Napkin (Collaborative Canvas)

When the napkin MCP server is available, you have a shared Excalidraw whiteboard.

**First step — always call:**
  start_session({ session_id: "<your channel ID>", webhook_url: "<your webhook URL>" })

**Drawing — use the intent API (no coordinates needed):**
  add_node, connect, move, resize, style, add_label, delete_element, patch_canvas, layout

**When using update_canvas for new elements**, only send the meaningful fields:
  id, type, x, y, width, height, and optionally strokeColor/backgroundColor/text.
  The server auto-fills all other fields (angle, seed, version, index, opacity, etc.).

**On webhook trigger:**
  1. First action: add_thought_bubble() — acknowledge visually before processing
  2. Use changed_elements from the payload — no round-trip needed
  3. Skip triggers with change_type "cosmetic" if you only care about structural changes
  4. Skip triggers with source "reconnect" — browser refresh, not human edits

**Export:** Use relative paths (e.g. "diagram.png") — resolved against the shared folder.
```

Adapt the `session_id`, `webhook_url`, and export path for your framework.

---

## Design decisions

**Canvas state is in-memory.** No persistence layer. If the server restarts, the canvas resets. The browser reconnects and sends its current state, so no data is lost as long as the browser tab is open. Export to `.excalidraw` for persistence.

**Pure canvas, no chat UI.** The conversation lives in the agent's channel (Slack, WhatsApp, etc.). Napkin is a visual tool, not a messaging app. The webhook/trigger system routes canvas events back to the originating channel. The `chat_message` WebSocket type exists for agent frameworks to inject messages programmatically — there is no chat panel in the browser.

**Server-side SVG rendering.** Vision and export render elements to SVG on the server, not in the browser. This works without a browser connected, avoids async WebSocket round-trips, and handles all standard element types. The one gap is pasted bitmap images.

**Animation via rapid patches.** Excalidraw has no native animation API. The server interpolates properties and pushes `canvas_patch` messages at ~30fps. The browser receives standard patches — no animation-specific code needed.

**Session model is agent-initiated.** The agent calls `start_session` with its channel identifier. Napkin doesn't know about Slack or WhatsApp — it just echoes the session_id in webhook payloads. The agent handles routing.

---

## Known issues and workarounds

### Excalidraw DPR rendering bug at zoom 1.0

Excalidraw 0.18.0 has a rendering bug at exactly `zoom.value === 1.0` on Retina/HiDPI displays. All elements (shapes and text) render with poor antialiasing — the canvas appears blurry or rough. At any other zoom value (0.99, 1.01, 1.1, etc.) rendering is crisp.

**Root cause:** On init, Excalidraw sets `appState.width/height` from `window.innerWidth/innerHeight`, then `updateDOMRect` corrects to the container's `getBoundingClientRect`. The `ShapeCache` (a `WeakMap` keyed by element reference) retains shapes rendered at the initial wrong dimensions. The `onResize` handler clears `ShapeCache` but doesn't fire on init. At zoom !== 1.0, a different code path triggers proper DPR scaling.

**Workaround:** Set initial zoom to 1.01 to avoid exactly 1.0:

```tsx
<Excalidraw initialData={{ appState: { zoom: { value: 1.01 } } }} />
```

This was initially misdiagnosed as a text font measurement issue. The visual roughness affected ALL elements equally — text AND shapes — which ruled out font metrics as the cause. Key diagnostic: manually drawn elements looked identical to programmatic ones; zooming to 110% fixed everything.

### Layout arrow repositioning

After `layout()` repositions nodes via Dagre, arrows are recomputed edge-to-edge based on new node positions. Excalidraw does not automatically reposition bound arrows when nodes move via `updateScene` — only interactive drag operations trigger arrow following.

### Phase status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1 | Complete | MCP server, WebSocket sync, spatial analysis, thought bubbles, vision, animation, sessions, webhooks, export |
| Phase 2 | Complete | Intent API, patch_canvas, layout (with arrow repositioning), change_summary, trigger filtering, DPR workaround |
