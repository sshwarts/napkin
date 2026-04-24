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
import { resolveArrowGeometry } from "./intent.js";

const LAYOUT_MARGIN = 50;
const RANKSEP = 120;
const NODESEP = 60;

type LayoutStyle = "tree" | "hierarchy" | "LR" | "TB";

interface ZonedNode {
  id: string;
  zone: string;
  row: number;
  el: ExcalidrawElement;
}

function extractZonedNodes(
  nodeIds: string[],
  elemById: Map<string, ExcalidrawElement>
): ZonedNode[] {
  const out: ZonedNode[] = [];
  for (const id of nodeIds) {
    const el = elemById.get(id);
    if (!el) continue;
    const cd = el.customData;
    if (typeof cd !== "object" || cd === null) continue;
    const rec = cd as Record<string, unknown>;
    const zone = typeof rec.zone === "string" ? rec.zone : undefined;
    const row = typeof rec.row === "number" && Number.isFinite(rec.row) ? rec.row : undefined;
    if (zone !== undefined && row !== undefined) {
      out.push({ id, zone, row, el });
    }
  }
  return out;
}

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
    nodesep: NODESEP,
    ranksep: RANKSEP,
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
  // Zone snap: override the rank-axis coordinate of zoned nodes so that
  // nodes sharing a row number share a rank (row in TB, column in LR),
  // independent of Dagre's edge-derived ranking. Cross-axis is kept from
  // Dagre to preserve connectivity-based ordering within the row.
  const zonedNodes = extractZonedNodes(g.nodes(), elemById);
  if (zonedNodes.length > 0) {
    const maxH = Math.max(...zonedNodes.map((z) => z.el.height));
    const maxW = Math.max(...zonedNodes.map((z) => z.el.width));
    if (rankdir === "TB") {
      const bandH = RANKSEP + maxH;
      for (const { id, row } of zonedNodes) {
        const ln = g.node(id);
        if (!ln) continue;
        ln.y = LAYOUT_MARGIN + maxH / 2 + row * bandH;
      }
    } else {
      const bandW = RANKSEP + maxW;
      for (const { id, row } of zonedNodes) {
        const ln = g.node(id);
        if (!ln) continue;
        ln.x = LAYOUT_MARGIN + maxW / 2 + row * bandW;
      }
    }
  }
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
    const arrowMetadata = (typeof el.customData === "object" && el.customData !== null)
      ? (el.customData as Record<string, unknown>)
      : undefined;
    const startId = el.startBinding?.elementId
      ?? (arrowMetadata && typeof arrowMetadata.from === "string" ? arrowMetadata.from : undefined);
    const endId = el.endBinding?.elementId
      ?? (arrowMetadata && typeof arrowMetadata.to === "string" ? arrowMetadata.to : undefined);
    const startPos = startId ? newPos.get(startId) : undefined;
    const endPos = endId ? newPos.get(endId) : undefined;
    if (!startPos && !endPos) continue;
    // Compute arrow from source edge to target edge using shared connect geometry.
    const fromCx = startPos ? startPos.x + startPos.w / 2 : el.x;
    const fromCy = startPos ? startPos.y + startPos.h / 2 : el.y;
    const pts = el.points as number[][] | undefined;
    const toCx = endPos ? endPos.x + endPos.w / 2 : el.x + (pts?.[1]?.[0] ?? 0);
    const toCy = endPos ? endPos.y + endPos.h / 2 : el.y + (pts?.[1]?.[1] ?? 0);
    const geometry = resolveArrowGeometry(
      {
        x: startPos ? startPos.x : fromCx,
        y: startPos ? startPos.y : fromCy,
        width: startPos ? startPos.w : 0,
        height: startPos ? startPos.h : 0,
      },
      {
        x: endPos ? endPos.x : toCx,
        y: endPos ? endPos.y : toCy,
        width: endPos ? endPos.w : 0,
        height: endPos ? endPos.h : 0,
      }
    );
    const startX = geometry.startX;
    const startY = geometry.startY;
    const dx = geometry.dx;
    const dy = geometry.dy;
    const existingMetadata = arrowMetadata ?? {};
    const fromNodeId = (typeof existingMetadata.from === "string" && existingMetadata.from.length > 0)
      ? existingMetadata.from
      : startId;
    const toNodeId = (typeof existingMetadata.to === "string" && existingMetadata.to.length > 0)
      ? existingMetadata.to
      : endId;
    const metadataPatch: Record<string, unknown> = { ...existingMetadata };
    if (fromNodeId) metadataPatch.from = fromNodeId;
    if (toNodeId) metadataPatch.to = toNodeId;
    patches.push({
      id: el.id,
      x: startX,
      y: startY,
      width: Math.abs(dx),
      height: Math.abs(dy),
      points: [[0, 0], [dx, dy]],
      startBinding: startId ? { elementId: startId, focus: 0, gap: 1 } : null,
      endBinding: endId ? { elementId: endId, focus: 0, gap: 1 } : null,
      customData: metadataPatch,
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
