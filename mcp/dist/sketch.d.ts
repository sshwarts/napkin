/**
 * @file Visual description for Napkin — any canvas element(s).
 *
 * Renders specified elements to SVG → PNG server-side, sends to Claude
 * vision for description, creates a grouped text annotation on the canvas.
 * Works for freedraw, rectangles, ellipses, diamonds, arrows, text, and
 * multi-element groups.
 */
import type { ExcalidrawElement } from "./types.js";
import type { CanvasWebSocketServer } from "./websocket.js";
/**
 * Render one or more Excalidraw elements to a single SVG string.
 * Also includes bound text elements (labels inside shapes).
 */
export declare function renderElementsToSvg(targetElements: ExcalidrawElement[], allElements: ExcalidrawElement[]): string;
/**
 * Describe one or more canvas elements: render to SVG → PNG, send to vision
 * model, create a grouped text annotation on the canvas.
 */
export declare function describeElements(wss: CanvasWebSocketServer, elementIds: string[], prompt?: string): Promise<{
    description: string;
} | {
    error: string;
}>;
/**
 * Convenience wrapper: describe a single freehand sketch element.
 * Kept for backwards compatibility.
 */
export declare function describeSketch(wss: CanvasWebSocketServer, elementId: string): Promise<{
    description: string;
} | {
    error: string;
}>;
//# sourceMappingURL=sketch.d.ts.map