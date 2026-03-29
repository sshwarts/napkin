/**
 * @file Auto-layout engine for Napkin.
 *
 * Runs Dagre on existing nodes and edges to compute positions,
 * then patches all elements in place. Agents call layout() after
 * adding nodes and connections — no coordinate math needed.
 */
import type { CanvasWebSocketServer } from "./websocket.js";
type LayoutStyle = "tree" | "hierarchy" | "LR" | "TB";
/**
 * Auto-layout the canvas using Dagre.
 * Repositions all nodes based on edges. Non-node elements are left in place.
 */
export declare function layoutCanvas(wss: CanvasWebSocketServer, style?: LayoutStyle, rootId?: string): {
    ok: true;
    nodeCount: number;
} | {
    error: string;
};
export {};
//# sourceMappingURL=layout.d.ts.map