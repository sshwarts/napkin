/**
 * @file Animation engine for Napkin.
 *
 * Simulates element animation via rapid WebSocket canvas_patch messages
 * at ~30fps. The MCP server handles interpolation — no browser-side
 * animation code needed.
 */
import type { CanvasWebSocketServer } from "./websocket.js";
/**
 * Animate a single element from its current state to the target properties.
 * Resolves when the animation completes.
 */
export declare function animateElement(wss: CanvasWebSocketServer, elementId: string, target: Record<string, unknown>, durationMs: number, easing?: string, commit?: Record<string, unknown>): Promise<{
    ok: true;
} | {
    error: string;
}>;
//# sourceMappingURL=animate.d.ts.map