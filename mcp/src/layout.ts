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
    ranksep: 120,
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
  // Recompute arrow positions based on new node positions.
  // Build a map of new node positions (after layout patches applied).
  const newPos = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const nodeId of g.nodes()) {
    const layoutNode = g.node(nodeId);
    const el = elemById.get(nodeId);
    if (!layoutNode || !el) continue;
    newPos.set(nodeId, {
      x: layoutNode.x - el.width / 2,
      y: layoutNode.y - el.height / 2,
      w: el.width,
      h: el.height,
    });
  }
  // Update each arrow that has bindings to repositioned nodes.
  for (const el of elements) {
    if (el.type !== "arrow") continue;
    const startId = el.startBinding?.elementId;
    const endId = el.endBinding?.elementId;
    const startPos = startId ? newPos.get(startId) : undefined;
    const endPos = endId ? newPos.get(endId) : undefined;
    if (!startPos && !endPos) continue;
    // Compute arrow from source edge to target edge.
    const fromCx = startPos ? startPos.x + startPos.w / 2 : el.x;
    const fromCy = startPos ? startPos.y + startPos.h / 2 : el.y;
    const pts = el.points as number[][] | undefined;
    const toCx = endPos ? endPos.x + endPos.w / 2 : el.x + (pts?.[1]?.[0] ?? 0);
    const toCy = endPos ? endPos.y + endPos.h / 2 : el.y + (pts?.[1]?.[1] ?? 0);
    const rawDx = toCx - fromCx;
    const rawDy = toCy - fromCy;
    // Determine primary direction and compute edge-to-edge points.
    let startX: number, startY: number, endX: number, endY: number;
    if (Math.abs(rawDx) >= Math.abs(rawDy)) {
      // Horizontal: right edge of source → left edge of target (or vice versa).
      if (rawDx >= 0) {
        startX = startPos ? startPos.x + startPos.w : fromCx;
        endX = endPos ? endPos.x : toCx;
      } else {
        startX = startPos ? startPos.x : fromCx;
        endX = endPos ? endPos.x + endPos.w : toCx;
      }
      startY = fromCy;
      endY = toCy;
    } else {
      // Vertical: bottom edge of source → top edge of target (or vice versa).
      if (rawDy >= 0) {
        startY = startPos ? startPos.y + startPos.h : fromCy;
        endY = endPos ? endPos.y : toCy;
      } else {
        startY = startPos ? startPos.y : fromCy;
        endY = endPos ? endPos.y + endPos.h : toCy;
      }
      startX = fromCx;
      endX = toCx;
    }
    const dx = endX - startX;
    const dy = endY - startY;
    patches.push({
      id: el.id,
      x: startX,
      y: startY,
      width: Math.abs(dx),
      height: Math.abs(dy),
      points: [[0, 0], [dx, dy]],
    });
    // Also reposition the arrow's bound text label if it has one.
    if (el.boundElements) {
      for (const bound of el.boundElements) {
        if (bound.type === "text") {
          const textEl = elemById.get(bound.id);
          if (textEl) {
            patches.push({
              id: bound.id,
              x: fromCx + dx / 2 - textEl.width / 2,
              y: fromCy + dy / 2 - textEl.height / 2,
            });
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
