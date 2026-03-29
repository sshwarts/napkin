/**
 * @file Auto-layout engine for Napkin.
 *
 * Runs Dagre on existing nodes and edges to compute positions,
 * then patches all elements in place. Agents call layout() after
 * adding nodes and connections — no coordinate math needed.
 */

import dagre from "dagre";
import type { ExcalidrawElement } from "./types.js";
import type { CanvasWebSocketServer } from "./websocket.js";
import { analyzeCanvas } from "./spatial.js";

const LAYOUT_MARGIN = 50;

type LayoutStyle = "tree" | "hierarchy" | "LR" | "TB";

/**
 * Auto-layout the canvas using Dagre.
 * Repositions all nodes based on edges. Non-node elements are left in place.
 */
export function layoutCanvas(
  wss: CanvasWebSocketServer,
  style: LayoutStyle = "TB",
  rootId?: string
): { ok: true; nodeCount: number } | { error: string } {
  const elements = wss.getCanvasElements();
  const structured = analyzeCanvas(elements);
  if (structured.nodes.length === 0) {
    return { error: "No nodes to layout." };
  }
  // Create a dagre graph.
  const g = new dagre.graphlib.Graph();
  const rankdir = (style === "LR" || style === "tree") ? "LR" : "TB";
  g.setGraph({
    rankdir,
    nodesep: 60,
    ranksep: 80,
    marginx: LAYOUT_MARGIN,
    marginy: LAYOUT_MARGIN,
  });
  g.setDefaultEdgeLabel(() => ({}));
  // Add nodes.
  const elemById = new Map(elements.map((el) => [el.id, el]));
  for (const node of structured.nodes) {
    const el = elemById.get(node.id);
    if (!el) continue;
    g.setNode(node.id, { width: el.width, height: el.height });
  }
  // Add edges.
  for (const edge of structured.edges) {
    if (g.hasNode(edge.from) && g.hasNode(edge.to)) {
      g.setEdge(edge.from, edge.to);
    }
  }
  // Run layout.
  dagre.layout(g);
  // Apply positions via patchCanvas.
  const patches: Array<Record<string, unknown>> = [];
  for (const nodeId of g.nodes()) {
    const layoutNode = g.node(nodeId);
    if (!layoutNode) continue;
    const el = elemById.get(nodeId);
    if (!el) continue;
    // Dagre gives center coordinates — convert to top-left.
    const newX = layoutNode.x - el.width / 2;
    const newY = layoutNode.y - el.height / 2;
    const dx = newX - el.x;
    const dy = newY - el.y;
    patches.push({ id: nodeId, x: newX, y: newY });
    // Also move bound text labels.
    if (el.boundElements) {
      for (const bound of el.boundElements) {
        if (bound.type === "text") {
          const textEl = elemById.get(bound.id);
          if (textEl) {
            patches.push({ id: bound.id, x: textEl.x + dx, y: textEl.y + dy });
          }
        }
      }
    }
  }
  if (patches.length > 0) {
    wss.patchCanvas(patches);
  }
  return { ok: true, nodeCount: structured.nodes.length };
}
