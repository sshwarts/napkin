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

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CanvasWebSocketServer } from "./websocket.js";
import type { SessionManager } from "./session.js";
import { analyzeCanvas } from "./spatial.js";
import { describeElements, describeSketch } from "./sketch.js";
import { animateElement } from "./animate.js";
import { exportCanvas } from "./export.js";
import { layoutCanvas } from "./layout.js";
import {
  addNode,
  connect,
  move,
  resize,
  styleElement,
  addLabel,
  deleteElement,
} from "./intent.js";
import {
  addThoughtBubble,
  confirmThoughtBubble,
  dismissThoughtBubble,
  listThoughtBubbles,
} from "./thought.js";

type IntentOpTool =
  | "add_node"
  | "connect"
  | "move"
  | "resize"
  | "style"
  | "add_label"
  | "delete_element"
  | "patch_canvas"
  | "update_canvas"
  | "clear_canvas"
  | "layout"
  | "add_thought_bubble"
  | "confirm_thought_bubble"
  | "dismiss_thought_bubble"
  | "animate_element";

interface IntentOperation {
  tool: IntentOpTool;
  args: Record<string, unknown>;
  ref?: string;
}

interface IntentOperationResult {
  index: number;
  tool: IntentOpTool;
  ok: boolean;
  output: Record<string, unknown>;
  ref?: string;
  error?: string;
}

function resolveRefPath(refStore: Record<string, Record<string, unknown>>, token: string): unknown {
  const raw = token.slice("$ref:".length);
  const parts = raw.split(".");
  if (parts.length < 2) {
    throw new Error(`Invalid ref token "${token}". Expected format "$ref:name.field".`);
  }
  const refName = parts[0];
  const refObj = refStore[refName];
  if (!refObj) {
    throw new Error(`Unknown ref "${refName}" in token "${token}".`);
  }
  let current: unknown = refObj;
  for (let i = 1; i < parts.length; i++) {
    if (typeof current !== "object" || current === null) {
      throw new Error(`Ref "${token}" resolved through non-object at "${parts.slice(0, i + 1).join(".")}".`);
    }
    current = (current as Record<string, unknown>)[parts[i]];
  }
  if (current === undefined) {
    throw new Error(`Ref "${token}" resolved to undefined.`);
  }
  return current;
}

function resolveRefs(value: unknown, refStore: Record<string, Record<string, unknown>>): unknown {
  if (typeof value === "string" && value.startsWith("$ref:")) {
    return resolveRefPath(refStore, value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveRefs(v, refStore));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = resolveRefs(val, refStore);
    }
    return result;
  }
  return value;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

interface TraceNode {
  id: string;
  label: string;
  type: "box" | "ellipse" | "diamond";
  status?: string;
  metadata?: Record<string, unknown>;
}

interface TraceEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

interface TracePathResult {
  start_nodes: string[];
  nodes_visited_order: string[];
  traversed_edges: string[];
  paths: Array<{
    start_node: string;
    nodes: string[];
    edges: string[];
  }>;
  truncated: boolean;
  reason: string | null;
}

function edgePassesMetadataFilter(edge: TraceEdge, filter?: Record<string, unknown>): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  const metadata = edge.metadata;
  if (!metadata) return false;
  for (const [k, v] of Object.entries(filter)) {
    if (metadata[k] !== v) return false;
  }
  return true;
}

function nodePassesFilter(node: TraceNode, filter?: {
  node_status?: string[];
  node_metadata?: Record<string, unknown>;
}): boolean {
  if (!filter) return true;
  if (filter.node_status && filter.node_status.length > 0) {
    if (!node.status || !filter.node_status.includes(node.status)) {
      return false;
    }
  }
  if (filter.node_metadata && Object.keys(filter.node_metadata).length > 0) {
    // Partial metadata match semantics: all specified keys must match; extra keys on node are allowed.
    const metadata = node.metadata;
    if (!metadata) return false;
    for (const [k, v] of Object.entries(filter.node_metadata)) {
      if (metadata[k] !== v) return false;
    }
  }
  return true;
}

function resolveStartNodes(
  nodes: TraceNode[],
  fromId: string | undefined,
  fromLabel: string | undefined,
  onAmbiguous: "error" | "first" | "all"
): { ids: string[] } | { error: string } {
  if (fromId) {
    const found = nodes.find((n) => n.id === fromId);
    if (!found) return { error: `from_id "${fromId}" not found.` };
    return { ids: [fromId] };
  }
  if (!fromLabel || fromLabel.trim().length === 0) {
    return { error: "Provide from_id or from_label." };
  }
  const normalized = fromLabel.trim().toLowerCase();
  const matches = nodes.filter((n) => n.label.trim().toLowerCase() === normalized);
  if (matches.length === 0) {
    return { error: `No node found for from_label "${fromLabel}".` };
  }
  if (matches.length === 1) {
    return { ids: [matches[0].id] };
  }
  if (onAmbiguous === "first") {
    return { ids: [matches[0].id] };
  }
  if (onAmbiguous === "all") {
    return { ids: matches.map((m) => m.id) };
  }
  return {
    error: `from_label "${fromLabel}" matched ${matches.length} nodes. Use from_id, or set on_ambiguous to "first" or "all".`,
  };
}

function traverseFromStart(
  startId: string,
  direction: "downstream" | "upstream" | "both",
  nodesById: Map<string, TraceNode>,
  outgoingByNode: Map<string, TraceEdge[]>,
  incomingByNode: Map<string, TraceEdge[]>,
  filter: {
    node_status?: string[];
    node_metadata?: Record<string, unknown>;
    edge_metadata?: Record<string, unknown>;
  } | undefined,
  maxDepth: number,
  maxPaths: number,
  maxVisited: number
): {
  visitedOrder: string[];
  traversedEdges: string[];
  paths: Array<{ start_node: string; nodes: string[]; edges: string[] }>;
  truncated: boolean;
  reason: string | null;
} {
  const queue: Array<{ nodeId: string; depth: number; pathNodes: string[]; pathEdges: string[] }> = [
    { nodeId: startId, depth: 0, pathNodes: [startId], pathEdges: [] },
  ];
  const visitedNodeDepth = new Map<string, number>();
  visitedNodeDepth.set(startId, 0);
  const visitedOrder: string[] = [startId];
  const traversedEdgeSet = new Set<string>();
  const paths: Array<{ start_node: string; nodes: string[]; edges: string[] }> = [];
  let truncated = false;
  let reason: string | null = null;
  while (queue.length > 0) {
    if (visitedOrder.length >= maxVisited) {
      truncated = true;
      reason = `max_nodes_visited (${maxVisited}) reached`;
      break;
    }
    if (paths.length >= maxPaths) {
      truncated = true;
      reason = `max_paths (${maxPaths}) reached`;
      break;
    }
    const current = queue.shift()!;
    const currentNode = nodesById.get(current.nodeId);
    if (!currentNode) continue;
    if (current.depth >= maxDepth) {
      paths.push({
        start_node: startId,
        nodes: [...current.pathNodes],
        edges: [...current.pathEdges],
      });
      continue;
    }
    const candidateEdges: TraceEdge[] = [];
    if (direction === "downstream" || direction === "both") {
      candidateEdges.push(...(outgoingByNode.get(current.nodeId) ?? []));
    }
    if (direction === "upstream" || direction === "both") {
      candidateEdges.push(...(incomingByNode.get(current.nodeId) ?? []));
    }
    const nextSteps: Array<{ edgeId: string; nextNodeId: string }> = [];
    for (const edge of candidateEdges) {
      if (!edgePassesMetadataFilter(edge, filter?.edge_metadata)) continue;
      const nextNodeId = edge.from === current.nodeId ? edge.to : edge.from;
      const nextNode = nodesById.get(nextNodeId);
      if (!nextNode) continue;
      if (!nodePassesFilter(nextNode, filter)) continue;
      nextSteps.push({ edgeId: edge.id, nextNodeId });
    }
    if (nextSteps.length === 0) {
      paths.push({
        start_node: startId,
        nodes: [...current.pathNodes],
        edges: [...current.pathEdges],
      });
      continue;
    }
    for (const step of nextSteps) {
      if (current.pathNodes.includes(step.nextNodeId)) {
        // Cycle-safe: skip revisiting a node already on the current path.
        continue;
      }
      traversedEdgeSet.add(step.edgeId);
      const nextDepth = current.depth + 1;
      const priorDepth = visitedNodeDepth.get(step.nextNodeId);
      if (priorDepth === undefined || nextDepth < priorDepth) {
        visitedNodeDepth.set(step.nextNodeId, nextDepth);
        visitedOrder.push(step.nextNodeId);
      }
      queue.push({
        nodeId: step.nextNodeId,
        depth: nextDepth,
        pathNodes: [...current.pathNodes, step.nextNodeId],
        pathEdges: [...current.pathEdges, step.edgeId],
      });
    }
  }
  return {
    visitedOrder,
    traversedEdges: Array.from(traversedEdgeSet),
    paths,
    truncated,
    reason,
  };
}

/**
 * Register all MCP tools on the given server.
 */
export function registerTools(server: McpServer, wss: CanvasWebSocketServer, sessions: SessionManager): void {
  const resolveOriginSessionId = (sessionId?: string): string | undefined => {
    if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
    return sessions.getActiveSession()?.sessionId;
  };
  server.tool(
    "get_canvas",
    "Returns the current canvas as a spatially analyzed structured object with nodes, edges, zones, sticky notes, thought bubbles, and freehand sketches.",
    {
      pretty: z.boolean().optional().describe("Pretty-print JSON output for debugging (default: false)"),
    },
    async ({ pretty }) => {
      const elements = wss.getCanvasElements();
      const structured = analyzeCanvas(elements);
      return {
        content: [
          {
            type: "text" as const,
            text: pretty ? JSON.stringify(structured, null, 2) : JSON.stringify(structured),
          },
        ],
      };
    }
  );

  server.tool(
    "get_canvas_summary",
    "Returns a compact semantic graph: nodes (id, label, type, optional status/metadata) and edges (id, from, to, optional label). Node types match get_canvas output: box, ellipse, diamond. Floor mode: include_metadata=false and include_status=false returns the cheapest read (id/label/type/from/to only).",
    {
      include_metadata: z.boolean().optional().describe("Include node metadata from customData (default: true)"),
      include_status: z.boolean().optional().describe("Include node status when available (default: true)"),
      pretty: z.boolean().optional().describe("Pretty-print JSON output for debugging (default: false)"),
    },
    async ({ include_metadata, include_status, pretty }) => {
      const includeMetadata = include_metadata ?? true;
      const includeStatus = include_status ?? true;
      const structured = analyzeCanvas(wss.getCanvasElements());
      const nodes = structured.nodes.map((node) => {
        const base: Record<string, unknown> = {
          id: node.id,
          label: node.label,
          type: node.type,
        };
        if (includeStatus && node.status !== undefined) base.status = node.status;
        if (includeMetadata && node.metadata !== undefined) base.metadata = node.metadata;
        return base;
      });
      const edges = structured.edges.map((edge) => {
        const base: Record<string, unknown> = {
          id: edge.id,
          from: edge.from,
          to: edge.to,
        };
        if (typeof edge.label === "string" && edge.label.length > 0) {
          base.label = edge.label;
        }
        return base;
      });
      const summary = { nodes, edges };
      return {
        content: [
          {
            type: "text" as const,
            text: pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary),
          },
        ],
      };
    }
  );

  server.tool(
    "trace_path",
    "Traverse semantic graph paths from a start node (from_id or from_label). Supports downstream/upstream/both traversal, branching BFS paths, and optional node/edge filters. Read-only in V1.",
    {
      from_id: z.string().optional().describe("Start node ID (preferred over from_label)"),
      from_label: z.string().optional().describe("Start node label (exact, case-insensitive match)"),
      direction: z.enum(["downstream", "upstream", "both"]).optional().describe("Traversal direction (default: downstream)"),
      on_ambiguous: z.enum(["error", "first", "all"]).optional().describe("When from_label matches multiple nodes (default: error)"),
      filter: z.object({
        node_status: z.array(z.string()).optional().describe("Allowed node statuses (OR within list)"),
        node_metadata: z.record(z.unknown()).optional().describe("Node metadata partial match (all specified keys must match)"),
        edge_metadata: z.record(z.unknown()).optional().describe("Edge metadata partial match (all specified keys must match)"),
      }).optional(),
      max_depth: z.number().optional().describe("Maximum traversal depth (default: 8)"),
      max_paths: z.number().optional().describe("Maximum number of returned paths (default: 50)"),
      max_nodes_visited: z.number().optional().describe("Maximum visited nodes across traversal (default: 500)"),
      pretty: z.boolean().optional().describe("Pretty-print JSON output for debugging (default: false)"),
    },
    async ({ from_id, from_label, direction, on_ambiguous, filter, max_depth, max_paths, max_nodes_visited, pretty }) => {
      const dir = direction ?? "downstream";
      const ambiguity = on_ambiguous ?? "error";
      const depthLimit = max_depth ?? 8;
      const pathLimit = max_paths ?? 50;
      const visitedLimit = max_nodes_visited ?? 500;
      const summary = analyzeCanvas(wss.getCanvasElements());
      const nodes: TraceNode[] = summary.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        type: n.type,
        ...(n.status ? { status: n.status } : {}),
        ...(n.metadata ? { metadata: n.metadata } : {}),
      }));
      const edges: TraceEdge[] = summary.edges.map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        ...(e.label ? { label: e.label } : {}),
        ...(e.metadata ? { metadata: e.metadata } : {}),
      }));
      const start = resolveStartNodes(nodes, from_id, from_label, ambiguity);
      if ("error" in start) {
        return {
          content: [{ type: "text" as const, text: `Error: ${start.error}` }],
          isError: true,
        };
      }
      const nodesById = new Map(nodes.map((n) => [n.id, n]));
      const outgoingByNode = new Map<string, TraceEdge[]>();
      const incomingByNode = new Map<string, TraceEdge[]>();
      for (const edge of edges) {
        if (!outgoingByNode.has(edge.from)) outgoingByNode.set(edge.from, []);
        if (!incomingByNode.has(edge.to)) incomingByNode.set(edge.to, []);
        outgoingByNode.get(edge.from)!.push(edge);
        incomingByNode.get(edge.to)!.push(edge);
      }
      const combined: TracePathResult = {
        start_nodes: start.ids,
        nodes_visited_order: [],
        traversed_edges: [],
        paths: [],
        truncated: false,
        reason: null,
      };
      const visitedOrderSet = new Set<string>();
      const traversedEdgeSet = new Set<string>();
      for (const startId of start.ids) {
        const startNode = nodesById.get(startId);
        if (!startNode) continue;
        if (!nodePassesFilter(startNode, filter as { node_status?: string[]; node_metadata?: Record<string, unknown> } | undefined)) {
          continue;
        }
        const result = traverseFromStart(
          startId,
          dir,
          nodesById,
          outgoingByNode,
          incomingByNode,
          filter as {
            node_status?: string[];
            node_metadata?: Record<string, unknown>;
            edge_metadata?: Record<string, unknown>;
          } | undefined,
          depthLimit,
          pathLimit,
          visitedLimit
        );
        for (const nodeId of result.visitedOrder) {
          if (!visitedOrderSet.has(nodeId)) {
            visitedOrderSet.add(nodeId);
            combined.nodes_visited_order.push(nodeId);
          }
        }
        for (const edgeId of result.traversedEdges) {
          if (!traversedEdgeSet.has(edgeId)) {
            traversedEdgeSet.add(edgeId);
            combined.traversed_edges.push(edgeId);
          }
        }
        combined.paths.push(...result.paths);
        if (result.truncated) {
          combined.truncated = true;
          if (!combined.reason) combined.reason = result.reason;
        }
        if (combined.paths.length >= pathLimit) {
          combined.paths = combined.paths.slice(0, pathLimit);
          combined.truncated = true;
          combined.reason = combined.reason ?? `max_paths (${pathLimit}) reached`;
          break;
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: pretty ? JSON.stringify(combined, null, 2) : JSON.stringify(combined),
          },
        ],
      };
    }
  );

  server.tool(
    "get_canvas_diff",
    "Returns only elements that changed since a given timestamp. Use to efficiently poll for updates without parsing the full canvas. The timestamp comes from a previous trigger or from Date.now() at your last read.",
    {
      since: z.number().describe("Epoch millisecond timestamp — returns elements where updated > since"),
      pretty: z.boolean().optional().describe("Pretty-print JSON output for debugging (default: false)"),
    },
    async ({ since, pretty }) => {
      const changed = wss.getCanvasDiff(since);
      if (changed.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No changes since that timestamp." }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: pretty ? JSON.stringify(changed, null, 2) : JSON.stringify(changed),
          },
        ],
      };
    }
  );

  server.tool(
    "get_canvas_raw",
    "Returns the raw Excalidraw JSON for the current canvas.",
    {},
    async () => {
      const raw = wss.getCanvasRaw();
      return {
        content: [
          {
            type: "text" as const,
            text: raw,
          },
        ],
      };
    }
  );

  server.tool(
    "get_pending_triggers",
    "Return and drain all pending agent triggers (debounce or chat). Returns an array of trigger objects with source, timestamp, and optional message.",
    {},
    async () => {
      const triggers = wss.drainTriggers();
      return {
        content: [
          {
            type: "text" as const,
            text: triggers.length > 0
              ? JSON.stringify(triggers)
              : "No pending triggers.",
          },
        ],
      };
    }
  );

  server.tool(
    "clear_canvas",
    "Remove all elements from the canvas.",
    {
      session_id: z.string().optional().describe("Originating session ID for webhook echo suppression."),
    },
    async ({ session_id }) => {
      wss.clearCanvas(resolveOriginSessionId(session_id));
      return {
        content: [
          {
            type: "text" as const,
            text: `Canvas cleared. Change broadcast to ${wss.getClientCount()} connected browser(s).`,
          },
        ],
      };
    }
  );

  server.tool(
    "patch_canvas",
    "Modify existing canvas elements without resending full definitions. Each patch is an object with an 'id' field and the fields to change. The server merges the patch with the cached element and broadcasts. Use for style changes, position tweaks, text edits — anything that modifies an existing element.",
    {
      session_id: z.string().optional().describe("Originating session ID for webhook echo suppression."),
      patches: z.array(z.record(z.unknown())).describe("Array<{ id: string, [field]: any }>. Only include the fields you want to change. JSON-string format is no longer accepted."),
    },
    async ({ patches, session_id }) => {
      if (!Array.isArray(patches)) {
        return {
          content: [{ type: "text" as const, text: "Error: patches must be an array of patch objects." }],
          isError: true,
        };
      }
      if (patches.some((p) => typeof p !== "object" || p === null || Array.isArray(p))) {
        return {
          content: [{ type: "text" as const, text: "Error: each patch must be an object." }],
          isError: true,
        };
      }
      const notFound = wss.patchCanvas(patches, resolveOriginSessionId(session_id));
      const applied = patches.length - notFound.length;
      let msg = `Patched ${applied} element(s).`;
      if (notFound.length > 0) {
        msg += ` Not found: ${notFound.join(", ")}`;
      }
      return {
        content: [{ type: "text" as const, text: msg }],
      };
    }
  );

  server.tool(
    "update_canvas",
    "Add new elements to the canvas. Requires full element definitions. For modifying existing elements, use patch_canvas instead.",
    {
      session_id: z.string().optional().describe("Originating session ID for webhook echo suppression."),
      elements: z.array(z.record(z.unknown())).describe(
        "Array of ExcalidrawElement objects to merge into the canvas. JSON-string format is no longer accepted."
      ),
    },
    async ({ elements, session_id }) => {
      if (!Array.isArray(elements)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: elements must be an array of ExcalidrawElement objects.",
            },
          ],
          isError: true,
        };
      }
      if (elements.some((el) => typeof el !== "object" || el === null || Array.isArray(el))) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: each element must be an object.",
            },
          ],
          isError: true,
        };
      }
      wss.updateCanvas(elements as import("./types.js").ExcalidrawElement[], resolveOriginSessionId(session_id));
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated canvas with ${elements.length} element(s). Change broadcast to ${wss.getClientCount()} connected browser(s).`,
          },
        ],
      };
    }
  );

  // --- Intent API (high-level drawing tools) ---

  server.tool(
    "add_node",
    "Add a labeled node to the canvas. Server handles placement — no coordinates needed. Returns the new element ID. Optional metadata is stored as customData (invisible in UI, returned in get_canvas). Conventions: intent, notes, status (wip|review|done|parking_lot), owner.",
    {
      label: z.string().describe("Text label for the node"),
      shape: z.enum(["rectangle", "ellipse", "diamond"]).optional().describe("Shape type (default: rectangle)"),
      style: z.record(z.unknown()).optional().describe("Style overrides: color, fill/background, opacity, strokeStyle, strokeWidth"),
      near: z.string().optional().describe("ID of an element to place the new node near"),
      metadata: z.record(z.unknown()).optional().describe("Non-visual metadata stored as customData. Conventions: intent, notes, status (wip|review|done|parking_lot), owner"),
      session_id: z.string().optional().describe("Originating session ID for webhook echo suppression."),
    },
    async ({ label, shape, style, near, metadata, session_id }) => {
      const id = addNode(wss, label, shape, style as Record<string, unknown> | undefined, near, metadata as Record<string, unknown> | undefined, resolveOriginSessionId(session_id));
      return { content: [{ type: "text" as const, text: `Created node "${label}" (${id})` }] };
    }
  );

  server.tool(
    "connect",
    "Connect two nodes with an arrow. Server computes binding points. Optionally add a label on the arrow.",
    {
      from_id: z.string().describe("Source node ID"),
      to_id: z.string().describe("Target node ID"),
      label: z.string().optional().describe("Optional label on the arrow"),
      session_id: z.string().optional().describe("Originating session ID for webhook echo suppression."),
    },
    async ({ from_id, to_id, label, session_id }) => {
      const result = connect(wss, from_id, to_id, label, resolveOriginSessionId(session_id));
      if (typeof result === "object" && "error" in result) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Connected ${from_id} → ${to_id} (arrow ${result})` }] };
    }
  );

  server.tool(
    "move",
    "Move an element by a relative offset. Also moves bound text labels.",
    {
      id: z.string().describe("Element ID to move"),
      dx: z.number().describe("Horizontal offset in pixels (positive = right)"),
      dy: z.number().describe("Vertical offset in pixels (positive = down)"),
      session_id: z.string().optional().describe("Originating session ID for webhook echo suppression."),
    },
    async ({ id, dx, dy, session_id }) => {
      const result = move(wss, id, dx, dy, resolveOriginSessionId(session_id));
      if ("error" in result) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Moved "${id}" by (${dx}, ${dy})` }] };
    }
  );

  server.tool(
    "resize",
    "Resize an element. Maintains center position.",
    {
      id: z.string().describe("Element ID to resize"),
      width: z.number().optional().describe("New width in pixels"),
      height: z.number().optional().describe("New height in pixels"),
      session_id: z.string().optional().describe("Originating session ID for webhook echo suppression."),
    },
    async ({ id, width, height, session_id }) => {
      const result = resize(wss, id, width, height, resolveOriginSessionId(session_id));
      if ("error" in result) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Resized "${id}"${width ? ` width=${width}` : ""}${height ? ` height=${height}` : ""}` }] };
    }
  );

  server.tool(
    "style",
    "Apply style changes to an element. Accepts: color, fill/background, opacity, strokeStyle, strokeWidth.",
    {
      id: z.string().describe("Element ID to style"),
      style: z.record(z.unknown()).describe("Style properties: color, fill, background, opacity, strokeStyle, strokeWidth"),
      session_id: z.string().optional().describe("Originating session ID for webhook echo suppression."),
    },
    async ({ id, style: s, session_id }) => {
      const result = styleElement(wss, id, s as Record<string, unknown>, resolveOriginSessionId(session_id));
      if ("error" in result) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Styled "${id}"` }] };
    }
  );

  server.tool(
    "add_label",
    "Add a floating text label near an element. Optional metadata is stored as customData (invisible in UI, returned in get_canvas).",
    {
      text: z.string().describe("Label text"),
      near_id: z.string().describe("ID of the element to place the label near"),
      metadata: z.record(z.unknown()).optional().describe("Non-visual metadata stored as customData"),
      session_id: z.string().optional().describe("Originating session ID for webhook echo suppression."),
    },
    async ({ text, near_id, metadata, session_id }) => {
      const result = addLabel(wss, text, near_id, metadata as Record<string, unknown> | undefined, resolveOriginSessionId(session_id));
      if (typeof result === "object" && "error" in result) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Added label "${text}" (${result})` }] };
    }
  );

  server.tool(
    "delete_element",
    "Delete an element and its bound text labels from the canvas.",
    {
      id: z.string().describe("Element ID to delete"),
      session_id: z.string().optional().describe("Originating session ID for webhook echo suppression."),
    },
    async ({ id, session_id }) => {
      const result = deleteElement(wss, id, resolveOriginSessionId(session_id));
      if ("error" in result) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Deleted "${id}"` }] };
    }
  );

  // --- Session tools ---

  server.tool(
    "start_session",
    "Start a whiteboard session. The session_id (typically your chat JID) is included in all webhook trigger payloads, allowing the receiver to route responses back to the correct conversation. Optionally override the webhook URL and debounce interval for this session.",
    {
      session_id: z.string().describe("Session identifier — use your chat JID so webhooks route back to the right channel"),
      webhook_url: z.string().optional().describe("Per-session webhook URL override (falls back to NAPKIN_TRIGGER_WEBHOOK env var)"),
      debounce_ms: z.number().optional().describe("Override debounce interval in ms for this session (default: AGENT_TRIGGER_DEBOUNCE_MS, 3000 if unset). Use lower values for games/discrete interactions, higher for drawing/whiteboarding."),
      compact_triggers: z.boolean().optional().describe("When true, webhook payloads use changed_elements_compact instead of full changed_elements for this session (default: false)."),
    },
    async ({ session_id, webhook_url, debounce_ms, compact_triggers }) => {
      sessions.startSession(session_id, webhook_url, debounce_ms, compact_triggers);
      wss.upsertSessionTrigger({
        sessionId: session_id,
        webhookUrl: webhook_url,
        debounceMs: debounce_ms,
        compactTriggers: compact_triggers,
      });
      const parts = [`Session "${session_id}" started.`];
      if (webhook_url) parts.push(`Webhook: ${webhook_url}`);
      if (debounce_ms !== undefined) parts.push(`Debounce: ${debounce_ms}ms`);
      if (compact_triggers !== undefined) parts.push(`Compact triggers: ${compact_triggers ? "on" : "off"}`);
      return {
        content: [{ type: "text" as const, text: parts.join(" ") }],
      };
    }
  );

  server.tool(
    "end_session",
    "End a whiteboard session. Stops webhook delivery for this session.",
    {
      session_id: z.string().describe("Session identifier to end"),
    },
    async ({ session_id }) => {
      const ended = sessions.endSession(session_id);
      wss.removeSessionTrigger(session_id);
      return {
        content: [
          {
            type: "text" as const,
            text: ended
              ? `Session "${session_id}" ended.`
              : `Session "${session_id}" not found.`,
          },
        ],
      };
    }
  );

  // --- Thought Bubble tools ---

  server.tool(
    "add_thought_bubble",
    "Create a dashed purple thought bubble on the canvas. Optionally position near an existing node.",
    {
      content: z.string().describe("Text content of the thought bubble"),
      near_node_id: z.string().optional().describe("ID of a node to position the bubble near"),
    },
    async ({ content, near_node_id }) => {
      const id = addThoughtBubble(wss, content, near_node_id);
      return {
        content: [
          {
            type: "text" as const,
            text: `Created thought bubble ${id}${near_node_id ? ` near node "${near_node_id}"` : ""}.`,
          },
        ],
      };
    }
  );

  server.tool(
    "confirm_thought_bubble",
    "Convert a thought bubble to a permanent element — removes dashed style, emoji prefix, and sets full opacity.",
    {
      id: z.string().describe("ID of the thought bubble to confirm"),
    },
    async ({ id }) => {
      const ok = confirmThoughtBubble(wss, id);
      if (!ok) {
        return {
          content: [{ type: "text" as const, text: `Error: thought bubble "${id}" not found.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Confirmed thought bubble "${id}" — now a permanent element.` }],
      };
    }
  );

  server.tool(
    "dismiss_thought_bubble",
    "Remove a thought bubble from the canvas entirely.",
    {
      id: z.string().describe("ID of the thought bubble to dismiss"),
    },
    async ({ id }) => {
      const ok = dismissThoughtBubble(wss, id);
      if (!ok) {
        return {
          content: [{ type: "text" as const, text: `Error: thought bubble "${id}" not found.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Dismissed thought bubble "${id}".` }],
      };
    }
  );

  server.tool(
    "list_thought_bubbles",
    "List all current thought bubbles on the canvas.",
    {},
    async () => {
      const bubbles = listThoughtBubbles(wss);
      return {
        content: [
          {
            type: "text" as const,
            text: bubbles.length > 0
              ? JSON.stringify(bubbles)
              : "No thought bubbles on the canvas.",
          },
        ],
      };
    }
  );

  // --- Visual Description tools (require ANTHROPIC_API_KEY) ---

  const hasVisionKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (hasVisionKey) {

  server.tool(
    "describe_elements",
    "Describe one or more canvas elements using vision AI. Renders the elements to PNG server-side, sends to a vision model, and creates a grouped text annotation. Use for freehand sketches, ambiguous diagrams, pasted content, or any element where JSON structure is insufficient.",
    {
      element_ids: z.array(z.string()).describe("IDs of elements to describe together"),
      prompt: z.string().optional().describe("Custom prompt for the vision model (default: 'Describe what this represents in one sentence')"),
    },
    async ({ element_ids, prompt }) => {
      const result = await describeElements(wss, element_ids, prompt);
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Described: "${result.description}". Annotation added to canvas.`,
          },
        ],
      };
    }
  );

  server.tool(
    "describe_sketch",
    "Convenience wrapper: describe a single freehand sketch element using vision AI.",
    {
      element_id: z.string().describe("ID of the freedraw element to describe"),
    },
    async ({ element_id }) => {
      const result = await describeSketch(wss, element_id);
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Sketch described: "${result.description}". Annotation added to canvas.`,
          },
        ],
      };
    }
  );

  } // end hasVisionKey

  // --- Layout tool ---

  server.tool(
    "layout",
    "Auto-arrange all nodes and edges on the canvas using Dagre graph layout. Removes the need for manual coordinate placement. Call after adding nodes and connections.",
    {
      style: z.enum(["tree", "hierarchy", "LR", "TB"]).optional().describe("Layout direction: tree/LR = left-to-right, hierarchy/TB = top-to-bottom (default: TB)"),
    },
    async ({ style }) => {
      const result = layoutCanvas(wss, style);
      if ("error" in result) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Layout applied to ${result.nodeCount} nodes.` }] };
    }
  );

  // --- Animation tool ---

  server.tool(
    "animate_element",
    "Animate an element's properties over time. Smoothly interpolates position, size, opacity, or color at ~30fps via WebSocket patches. The canvas remains interactive during animation. Use 'commit' to apply final properties atomically on completion (e.g. set isDeleted:true after a fade-out, or snap to exact position) — avoids a separate update_canvas call.",
    {
      id: z.string().describe("ID of the element to animate"),
      to: z.record(z.unknown()).describe("Target properties: x, y, width, height, opacity (number), strokeColor, backgroundColor (hex string)"),
      duration_ms: z.number().describe("Animation duration in milliseconds"),
      easing: z.enum(["linear", "ease-in", "ease-out"]).optional().describe("Easing function (default: linear)"),
      commit: z.record(z.unknown()).optional().describe("Properties to apply atomically on animation completion (e.g. { isDeleted: true } to remove after fade-out, or final position values)"),
      session_id: z.string().optional().describe("Originating session ID for webhook echo suppression."),
    },
    async ({ id, to, duration_ms, easing, commit, session_id }) => {
      const result = await animateElement(wss, id, to, duration_ms, easing, commit, resolveOriginSessionId(session_id));
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Animation complete: element "${id}" animated over ${duration_ms}ms.`,
          },
        ],
      };
    }
  );

  // --- Batch intent tool ---

  server.tool(
    "apply_intents",
    "Execute an ordered batch of intent/write operations in one MCP call. Supports $ref:name.field substitutions from prior operation outputs. On animate_element boundaries with broadcast_mode='end', pending structural writes are flushed before animation starts.",
    {
      operations: z.array(
        z.object({
          tool: z.enum([
            "add_node",
            "connect",
            "move",
            "resize",
            "style",
            "add_label",
            "delete_element",
            "patch_canvas",
            "update_canvas",
            "clear_canvas",
            "layout",
            "add_thought_bubble",
            "confirm_thought_bubble",
            "dismiss_thought_bubble",
            "animate_element",
          ]),
          args: z.record(z.unknown()).describe("Operation arguments. May contain $ref:name.field strings."),
          ref: z.string().optional().describe("Optional alias for this operation output, used by later $ref tokens."),
        })
      ).min(1),
      session_id: z.string().optional().describe("Originating session ID for webhook echo suppression."),
      cancel_on_error: z.boolean().optional().describe("Stop at first failure (default: true)."),
      broadcast_mode: z.enum(["end", "per_op"]).optional().describe("Write broadcast mode (default: end)."),
    },
    async ({ operations, session_id, cancel_on_error, broadcast_mode }) => {
      const originSessionId = resolveOriginSessionId(session_id);
      const shouldCancelOnError = cancel_on_error ?? true;
      const mode = broadcast_mode ?? "end";
      const opResults: IntentOperationResult[] = [];
      const refs: Record<string, Record<string, unknown>> = {};
      let failedIndex: number | null = null;
      let batchingActive = false;
      const beginBatch = (): void => {
        if (mode !== "end" || batchingActive) return;
        wss.beginBatchBroadcast();
        batchingActive = true;
      };
      const endBatch = (): void => {
        if (!batchingActive) return;
        wss.endBatchBroadcast();
        batchingActive = false;
      };
      const flushBatch = (): void => {
        if (!batchingActive) return;
        wss.flushBatchBroadcast();
      };
      const executeOperation = async (op: IntentOperation, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        switch (op.tool) {
          case "add_node": {
            const label = args.label;
            if (typeof label !== "string") throw new Error("add_node requires string arg 'label'.");
            const id = addNode(
              wss,
              label,
              typeof args.shape === "string" ? args.shape : undefined,
              typeof args.style === "object" && args.style !== null ? args.style as Record<string, unknown> : undefined,
              typeof args.near === "string" ? args.near : undefined,
              typeof args.metadata === "object" && args.metadata !== null ? args.metadata as Record<string, unknown> : undefined,
              originSessionId
            );
            return { id };
          }
          case "connect": {
            const fromId = args.from_id;
            const toId = args.to_id;
            if (typeof fromId !== "string" || typeof toId !== "string") {
              throw new Error("connect requires string args 'from_id' and 'to_id'.");
            }
            const result = connect(wss, fromId, toId, typeof args.label === "string" ? args.label : undefined, originSessionId);
            if (typeof result === "object" && "error" in result) throw new Error(result.error);
            return { id: result };
          }
          case "move": {
            const id = args.id;
            const dx = args.dx;
            const dy = args.dy;
            if (typeof id !== "string" || typeof dx !== "number" || typeof dy !== "number") {
              throw new Error("move requires args { id: string, dx: number, dy: number }.");
            }
            const result = move(wss, id, dx, dy, originSessionId);
            if ("error" in result) throw new Error(result.error);
            return {};
          }
          case "resize": {
            const id = args.id;
            if (typeof id !== "string") throw new Error("resize requires string arg 'id'.");
            const width = typeof args.width === "number" ? args.width : undefined;
            const height = typeof args.height === "number" ? args.height : undefined;
            const result = resize(wss, id, width, height, originSessionId);
            if ("error" in result) throw new Error(result.error);
            return {};
          }
          case "style": {
            const id = args.id;
            if (typeof id !== "string") throw new Error("style requires string arg 'id'.");
            const styleArgs = asRecord(args.style, "style arg 'style'");
            const result = styleElement(wss, id, styleArgs, originSessionId);
            if ("error" in result) throw new Error(result.error);
            return {};
          }
          case "add_label": {
            const text = args.text;
            const nearId = args.near_id;
            if (typeof text !== "string" || typeof nearId !== "string") {
              throw new Error("add_label requires args { text: string, near_id: string }.");
            }
            const result = addLabel(
              wss,
              text,
              nearId,
              typeof args.metadata === "object" && args.metadata !== null ? args.metadata as Record<string, unknown> : undefined,
              originSessionId
            );
            if (typeof result === "object" && "error" in result) throw new Error(result.error);
            return {};
          }
          case "delete_element": {
            const id = args.id;
            if (typeof id !== "string") throw new Error("delete_element requires string arg 'id'.");
            const result = deleteElement(wss, id, originSessionId);
            if ("error" in result) throw new Error(result.error);
            return {};
          }
          case "patch_canvas": {
            if (!Array.isArray(args.patches)) throw new Error("patch_canvas requires array arg 'patches'.");
            const patches = args.patches as Array<Record<string, unknown>>;
            const notFound = wss.patchCanvas(patches, originSessionId);
            if (notFound.length > 0) throw new Error(`patch_canvas not found ids: ${notFound.join(", ")}`);
            return {};
          }
          case "update_canvas": {
            if (!Array.isArray(args.elements)) throw new Error("update_canvas requires array arg 'elements'.");
            wss.updateCanvas(args.elements as import("./types.js").ExcalidrawElement[], originSessionId);
            return {};
          }
          case "clear_canvas": {
            wss.clearCanvas(originSessionId);
            return {};
          }
          case "layout": {
            const style = typeof args.style === "string" ? args.style : undefined;
            const result = layoutCanvas(wss, style as "tree" | "hierarchy" | "LR" | "TB" | undefined);
            if ("error" in result) throw new Error(result.error);
            return {};
          }
          case "add_thought_bubble": {
            const content = args.content;
            if (typeof content !== "string") throw new Error("add_thought_bubble requires string arg 'content'.");
            const id = addThoughtBubble(wss, content, typeof args.near_node_id === "string" ? args.near_node_id : undefined);
            return { id };
          }
          case "confirm_thought_bubble": {
            const id = args.id;
            if (typeof id !== "string") throw new Error("confirm_thought_bubble requires string arg 'id'.");
            const ok = confirmThoughtBubble(wss, id);
            if (!ok) throw new Error(`Thought bubble "${id}" not found.`);
            return {};
          }
          case "dismiss_thought_bubble": {
            const id = args.id;
            if (typeof id !== "string") throw new Error("dismiss_thought_bubble requires string arg 'id'.");
            const ok = dismissThoughtBubble(wss, id);
            if (!ok) throw new Error(`Thought bubble "${id}" not found.`);
            return {};
          }
          case "animate_element": {
            const id = args.id;
            const to = args.to;
            const duration = args.duration_ms;
            if (typeof id !== "string") throw new Error("animate_element requires string arg 'id'.");
            if (typeof duration !== "number") throw new Error("animate_element requires numeric arg 'duration_ms'.");
            const toObj = asRecord(to, "animate_element arg 'to'");
            const easing = typeof args.easing === "string" ? args.easing : undefined;
            const commit = (typeof args.commit === "object" && args.commit !== null)
              ? args.commit as Record<string, unknown>
              : undefined;
            const result = await animateElement(wss, id, toObj, duration, easing as "linear" | "ease-in" | "ease-out" | undefined, commit, originSessionId);
            if ("error" in result) throw new Error(result.error);
            return {};
          }
          default:
            throw new Error(`Unsupported operation tool "${op.tool}".`);
        }
      };
      beginBatch();
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i] as IntentOperation;
        const isAnimation = op.tool === "animate_element";
        if (isAnimation && mode === "end") {
          // Animation requires browser-visible pre-state; flush deferred writes first.
          flushBatch();
          endBatch();
        }
        try {
          const resolvedArgs = resolveRefs(op.args, refs) as Record<string, unknown>;
          const output = await executeOperation(op, resolvedArgs);
          const opResult: IntentOperationResult = {
            index: i,
            tool: op.tool,
            ok: true,
            output,
            ...(op.ref ? { ref: op.ref } : {}),
          };
          opResults.push(opResult);
          if (op.ref) refs[op.ref] = output;
        } catch (err: unknown) {
          failedIndex = i;
          const message = err instanceof Error ? err.message : String(err);
          opResults.push({
            index: i,
            tool: op.tool,
            ok: false,
            output: {},
            ...(op.ref ? { ref: op.ref } : {}),
            error: message,
          });
          if (shouldCancelOnError) {
            break;
          }
        } finally {
          if (isAnimation && mode === "end" && i < operations.length - 1) {
            beginBatch();
          }
        }
      }
      endBatch();
      const ok = failedIndex === null;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok,
              executed: opResults.filter((r) => r.ok).length,
              failed_index: failedIndex,
              results: opResults,
              summary: ok
                ? `Executed ${opResults.length} operation(s).`
                : `Failed at operation index ${failedIndex}.`,
            }),
          },
        ],
        ...(ok ? {} : { isError: shouldCancelOnError }),
      };
    }
  );

  // --- Export tool ---

  server.tool(
    "export_canvas",
    "Export the current canvas to a file. Format is inferred from the file extension: .excalidraw (JSON, reopenable), .svg (vector), or .png (raster). The server renders SVG/PNG server-side — no browser needed.",
    {
      file_path: z.string().describe("Absolute path to write the file to. Extension determines format (.excalidraw, .svg, .png)"),
    },
    async ({ file_path }) => {
      const result = await exportCanvas(wss, file_path);
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Exported ${result.elementCount} elements to ${result.path}`,
          },
        ],
      };
    }
  );
}
