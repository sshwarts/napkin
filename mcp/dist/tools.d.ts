/**
 * @file MCP tool implementations for Napkin.
 *
 * 26 tools organized by category:
 * Read: get_canvas, get_canvas_summary, get_canvas_diff, get_canvas_raw, get_pending_triggers
 * Intent API: add_node, connect, move, resize, style, add_label, delete_element
 * Write: patch_canvas, update_canvas, clear_canvas, apply_intents
 * Layout: layout
 * Thought bubbles: add/confirm/dismiss/list_thought_bubble(s)
 * Vision: describe_elements, describe_sketch (requires API key)
 * Animation/Export: animate_element, export_canvas
 * Sessions: start_session, end_session
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CanvasWebSocketServer } from "./websocket.js";
import type { SessionManager } from "./session.js";
/**
 * Register all MCP tools on the given server.
 */
export declare function registerTools(server: McpServer, wss: CanvasWebSocketServer, sessions: SessionManager): void;
//# sourceMappingURL=tools.d.ts.map