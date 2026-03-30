/**
 * @file Intent API for Napkin — high-level drawing tools.
 *
 * Agents describe what they want, the server handles where and how.
 * No coordinates, no JSON construction, no Excalidraw internals.
 */
import type { ExcalidrawElement } from "./types.js";
import type { CanvasWebSocketServer } from "./websocket.js";
declare function genIndex(_elements: ExcalidrawElement[]): string;
export { genIndex };
/**
 * Add a labeled node to the canvas. Server handles placement.
 */
export declare function addNode(wss: CanvasWebSocketServer, label: string, shape?: string, style?: Record<string, unknown>, near?: string, metadata?: Record<string, unknown>): string;
/**
 * Connect two nodes with an arrow. Server computes binding points.
 */
export declare function connect(wss: CanvasWebSocketServer, fromId: string, toId: string, label?: string): string | {
    error: string;
};
/**
 * Move an element by a relative offset.
 */
export declare function move(wss: CanvasWebSocketServer, id: string, dx: number, dy: number): {
    ok: true;
} | {
    error: string;
};
/**
 * Resize an element. Maintains center position.
 */
export declare function resize(wss: CanvasWebSocketServer, id: string, width?: number, height?: number): {
    ok: true;
} | {
    error: string;
};
/**
 * Apply style changes to an element. Thin wrapper over patchCanvas.
 */
export declare function styleElement(wss: CanvasWebSocketServer, id: string, style: Record<string, unknown>): {
    ok: true;
} | {
    error: string;
};
/**
 * Add a floating text label near an element.
 */
export declare function addLabel(wss: CanvasWebSocketServer, text: string, nearId: string, metadata?: Record<string, unknown>): string | {
    error: string;
};
/**
 * Delete an element and its bound text.
 */
export declare function deleteElement(wss: CanvasWebSocketServer, id: string): {
    ok: true;
} | {
    error: string;
};
//# sourceMappingURL=intent.d.ts.map