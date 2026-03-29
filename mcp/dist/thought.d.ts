/**
 * @file Thought bubble protocol for Napkin.
 *
 * Creates, confirms, and dismisses thought bubble elements on the canvas.
 * Thought bubbles are visually distinct (dashed, purple, translucent) and
 * positioned to avoid overlapping existing elements.
 */
import type { CanvasWebSocketServer } from "./websocket.js";
/**
 * Create a thought bubble element pair (container + text) and push to the canvas.
 * Returns the container element's ID.
 */
export declare function addThoughtBubble(wss: CanvasWebSocketServer, content: string, nearNodeId?: string): string;
/**
 * Confirm a thought bubble — convert to permanent element.
 * Removes dashed style, removes emoji prefix, sets opacity to 100.
 */
export declare function confirmThoughtBubble(wss: CanvasWebSocketServer, bubbleId: string): boolean;
/**
 * Dismiss (delete) a thought bubble from the canvas.
 */
export declare function dismissThoughtBubble(wss: CanvasWebSocketServer, bubbleId: string): boolean;
/**
 * List all current thought bubbles on the canvas.
 */
export declare function listThoughtBubbles(wss: CanvasWebSocketServer): Array<{
    id: string;
    content: string;
    nearNodeId?: string;
}>;
//# sourceMappingURL=thought.d.ts.map