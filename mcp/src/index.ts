/**
 * @file Napkin MCP server entry point.
 *
 * Starts two services:
 *   1. WebSocket server for real-time browser canvas sync
 *   2. MCP server for agent tool access (stdio or HTTP transport)
 *
 * Transport selection via NAPKIN_TRANSPORT env var:
 *   - "http" → HTTP server on NAPKIN_MCP_PORT (default 3003)
 *   - default → stdio (stdin/stdout JSON-RPC)
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { CanvasWebSocketServer } from "./websocket.js";
import { SessionManager } from "./session.js";
import { registerTools } from "./tools.js";
import { startWebhookDelivery } from "./webhook.js";

const DEFAULT_MCP_PORT = 3003;

/** Shared session manager — single instance across all MCP sessions. */
let sharedSessionManager: SessionManager;

/**
 * Create and configure an MCP server instance with all tools registered.
 */
const SERVER_INSTRUCTIONS_COMPACT = `Napkin is a shared visual canvas (Excalidraw) for collaborative whiteboarding between agents and humans.

Core operating rules:
1. Call start_session() first with your conversation identifier as session_id and your webhook URL. Use compact_triggers: true.
2. Prefer intent APIs (add_node, connect, move, resize, style, patch_canvas, apply_intents) over raw JSON construction.
3. Always end diagram construction with layout() — prevents node placement drift. Use TB for hierarchies, LR for pipelines/flows.
4. On webhook triggers, use changed_element_ids + changed_elements/changed_elements_compact directly; avoid unnecessary round-trips.
5. No webhook? Call get_pending_triggers() to drain queued canvas change events.
Need full guidance/examples? Call get_server_instructions({ verbose: true }).`;

const SERVER_INSTRUCTIONS_VERBOSE = `Napkin is a shared visual canvas (Excalidraw) for collaborative whiteboarding between agents and humans.

## Getting started
1. Call start_session() with your conversation identifier (e.g. your chat JID or channel ID) as session_id, and a webhook_url where canvas events should be POSTed. Set compact_triggers: true to reduce webhook payload size. This ensures triggers route back to the correct conversation.
2. Use get_canvas() to read the current canvas as structured data (nodes, edges, zones, thought bubbles).
3. Use the intent API to draw: add_node(), connect(), move(), resize(), style(), add_label(), delete_element(). No coordinates or JSON construction needed.
4. Always call layout() as the final step of diagram construction. Use TB for hierarchies/org charts, LR for pipelines and sequences.
5. When adding nodes to an existing canvas, call get_canvas_summary() first to understand current layout, then use near: to anchor new nodes near existing content.

## Drawing (Intent API)
Use these tools instead of update_canvas for most operations — they're 10-20x smaller payloads and require no coordinate math:
• **add_node(label, shape?, style?, near?, metadata?)** — creates a labeled node, server finds open space. Use near: existing_node_id when adding to an existing canvas — without it, nodes are placed in open space, typically to the right of existing content. Optional metadata stored as customData (invisible in UI, returned in get_canvas).
• **connect(from_id, to_id, label?)** — creates an arrow with proper bindings. Arrow labels go here — do NOT create a separate text element to annotate a connection.
• **move(id, dx, dy)** — relative offset, moves bound text too
• **resize(id, width?, height?)** — maintains center position
• **style(id, style)** — color, fill, opacity, strokeStyle changes
• **add_label(text, near_id, metadata?)** — floating text anchored near a specific element. Always provide near_id — unanchored labels drift after layout and clutter the canvas.
• **delete_element(id)** — removes element and bound text
• **patch_canvas(patches)** — modify any element field without resending the full definition. Pass patches as an array of objects (not a JSON-encoded string)
• **apply_intents(operations, cancel_on_error?, broadcast_mode?)** — execute ordered intent/write ops in one call. Supports $ref:name.field substitutions from prior outputs. Canonical pattern: batch all node/connect operations with layout as the final op to prevent placement drift and minimize round-trips.
• **layout(style?)** — auto-arrange all nodes and reposition arrows edge-to-edge. TB (default) for hierarchies/org charts, LR for pipelines/flows/sequences. Always call as the final step of diagram construction.

Only use update_canvas() for new elements not covered by add_node/connect. Pass elements as an array of objects (not a JSON-encoded string). Always send complete element definitions to update_canvas — partial objects break elements.

## Annotations: use the right tool
• Connection labels → connect(from, to, label) — not a separate text element
• Node annotation → add_label(text, near_id: node_id) — always anchor to the node
• General canvas note → add_label(text, near_id: nearest_relevant_element) — always anchor, never free-floating
• Avoid orphaned text: floating labels without a near_id drift after layout and cannot be repositioned by layout()

## Other tools
• **Thought bubbles**: add_thought_bubble() to propose, confirm_thought_bubble() to make permanent, dismiss_thought_bubble() to remove.
• **Spatial analysis**: get_canvas() returns semantically analyzed structure — nodes, edges, zones, proximity-inferred properties, and metadata (from customData) when present.
• **Compact reads**: get_canvas_summary() returns nodes/edges only. Node types use the same vocabulary as get_canvas (box, ellipse, diamond). Cheapest mode: include_metadata=false and include_status=false.
• **Path traversal**: trace_path() returns BFS paths/visited nodes from a start node (id or label) with downstream/upstream/both traversal and optional filters. V1 is read-only.
• **Efficient deltas**: Trigger payloads include changed_element_ids, changed_elements (full data), and change_summary (human-readable). Use these instead of calling get_canvas_diff.
• **Vision**: describe_elements() renders element(s) to PNG and sends to a vision model. Only available when ANTHROPIC_API_KEY is configured.
• **Animation**: animate_element() interpolates properties at ~30fps. Use commit parameter for atomic final state.
• **Export**: export_canvas() saves to .excalidraw/.svg/.png. Relative paths resolve against NAPKIN_EXPORT_DIR.

## Sessions
Your session_id appears in all webhook trigger payloads, allowing the receiver to route canvas events back to your active conversation. Sessions auto-expire after 2 hours of inactivity. Call end_session() when you're done to free resources.

Set debounce_ms in start_session() to match activity type:
• Drawing/whiteboarding: 3000ms (default) — filters mid-stroke noise
• Games/discrete interactions: 300-500ms — faster response to piece moves
• Passive monitoring: 5000ms+ — minimal wakeups

## Triggers
When the human draws on the canvas and stops, a debounce trigger fires after a quiet period. Triggers are only fired for human-originated changes — your own writes (update_canvas, animate_element, thought bubbles) never trigger a wakeup.

If you set a webhook URL (via start_session), triggers are POSTed as JSON with:
• changed_element_ids and changed_elements (or changed_elements_compact when compact_triggers is enabled) — act immediately, no round-trip
• change_summary — human-readable description (e.g. "moved Server +50px right; added rectangle")
• change_type — "semantic" (new/deleted/text/connection) or "cosmetic" (small nudge/style tweak). Skip cosmetic triggers if you only care about structural changes.

**No webhook?** Call get_pending_triggers() to drain queued trigger events, or get_canvas_diff(since: timestamp) to see what changed since your last read.

## Token efficiency
• **Show before think**: On a webhook trigger, your first action should be add_thought_bubble() to acknowledge the human's change visually. Then process. The user sees immediate feedback while you reason.
• Use changed_elements from the webhook payload instead of calling get_canvas() or get_canvas_diff() — the data is already there.
• Use apply_intents() for multi-step construction or animation cycles to minimize per-call protocol overhead.
• Use animate_element with commit to combine animation + position update in one call.
• Ignore triggers with source "reconnect" — these are browser reconnection events, not human edits. Don't poll or read the canvas on reconnect unless you need to verify state.
• Call end_session() when the whiteboarding is done. Don't leave sessions open indefinitely — they generate reconnect triggers on every browser refresh.
• Prefer get_canvas_diff(since) over get_canvas() when you only need to see what changed.

## update_canvas: server fills defaults
When using update_canvas() for new elements, you only need to send the fields that matter. The server auto-fills all missing fields with type-aware defaults. A minimal element needs just:
• type, x, y (required)
• id (optional — auto-generated if missing)
• width, height (optional — type-specific defaults: rectangle/ellipse 160×60, diamond 160×100, text auto-computed)
• strokeColor, backgroundColor (optional — defaults to black stroke, transparent fill)
• text (for text elements)

Example — a teal circle in 82 bytes:
  { "type": "ellipse", "x": 165, "y": 290, "width": 170, "height": 210, "backgroundColor": "#0D9488" }

The server fills: id, angle, seed, version, index, roundness (type-aware: rounded corners for shapes, smooth curves for arrows), opacity, strokeWidth, fillStyle, strokeStyle, groupIds, boundElements, frameId, link, locked, and type-specific fields (lineHeight/autoResize/fontFamily for text, points/arrowheads for arrows).

**Text elements:** Do NOT set fontFamily, width, or height — let the server default them. The server uses fontFamily 5 (Excalidraw's current default font) and calculates height from fontSize * lineHeight * lineCount. Setting wrong fontFamily or width values causes text to render with incorrect metrics. Just send: type, x, y, text, fontSize.

For modifying existing elements, use patch_canvas() or the intent tools (move, resize, style) instead.`;


function getServerInstructions(verbose: boolean): string {
  if (verbose) return SERVER_INSTRUCTIONS_VERBOSE;
  const profile = (process.env.NAPKIN_INSTRUCTIONS_PROFILE ?? "compact").toLowerCase();
  if (profile === "verbose") return SERVER_INSTRUCTIONS_VERBOSE;
  return SERVER_INSTRUCTIONS_COMPACT;
}

function buildMcpServer(wss: CanvasWebSocketServer): McpServer {
  const instructions = getServerInstructions(false);
  const server = new McpServer({
    name: "napkin",
    version: "0.1.0",
  }, {
    instructions,
  });
  registerTools(server, wss, sharedSessionManager);
  server.tool(
    "get_server_instructions",
    "Return compact or verbose server instructions for agent guidance.",
    {
      verbose: z.boolean().optional().describe("Return verbose onboarding/debug instructions (default: false)"),
    },
    async ({ verbose }) => ({
      content: [{ type: "text" as const, text: getServerInstructions(Boolean(verbose)) }],
    })
  );
  return server;
}

/**
 * Start the MCP server with stdio transport (single session).
 */
async function startStdioServer(wss: CanvasWebSocketServer): Promise<void> {
  const mcpServer = buildMcpServer(wss);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("[napkin] MCP server running on stdio");
}

/**
 * Start the MCP server with HTTP transport (multi-session).
 */
async function startHttpServer(wss: CanvasWebSocketServer): Promise<void> {
  const port = parseInt(process.env.NAPKIN_MCP_PORT ?? String(DEFAULT_MCP_PORT), 10);
  const mcpSessions = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Mcp-Session-Id"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    // Route MCP requests.
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && mcpSessions.has(sessionId)) {
      const transport = mcpSessions.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }
    if (sessionId && !mcpSessions.has(sessionId)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found — please reinitialize" }));
      return;
    }
    // New session.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        mcpSessions.delete(transport.sessionId);
      }
    };
    const mcpServer = buildMcpServer(wss);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    if (transport.sessionId) {
      mcpSessions.set(transport.sessionId, transport);
    }
  });
  httpServer.listen(port, () => {
    console.error(`[napkin] MCP HTTP server listening on port ${port}`);
  });
}

async function main(): Promise<void> {
  // 1. Start the WebSocket server for browser canvas sync.
  const wss = new CanvasWebSocketServer();
  wss.start();
  // 2. Initialize the session manager (restores from disk).
  sharedSessionManager = new SessionManager();
  // Restore session trigger routing/debounce state in WebSocket runtime.
  wss.restoreSessionTriggers(sharedSessionManager.listSessions());
  // 3. Start webhook delivery if configured.
  startWebhookDelivery(wss);
  // 4. Start the MCP server with the configured transport.
  const transport = process.env.NAPKIN_TRANSPORT ?? "http";
  if (transport === "http") {
    await startHttpServer(wss);
  } else {
    await startStdioServer(wss);
  }
  // Graceful shutdown.
  const shutdown = (): void => {
    console.error("[napkin] Shutting down...");
    sharedSessionManager.stop();
    wss.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error("[napkin] Fatal error:", err);
  process.exit(1);
});
