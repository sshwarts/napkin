/**
 * @file Canvas export for Napkin.
 *
 * Exports the current canvas to file in three formats:
 *   - .excalidraw (JSON) — server-side, always available
 *   - .svg — browser-side via Excalidraw's exportToSvg (pixel-perfect)
 *   - .png — browser-side via Excalidraw's exportToBlob (pixel-perfect)
 *
 * SVG/PNG require a connected browser. Falls back to server-side
 * rendering if no browser is available.
 */
import type { CanvasWebSocketServer } from "./websocket.js";
/**
 * Export the current canvas to a file.
 * Format is inferred from the file extension.
 * SVG/PNG use browser-side rendering when a browser is connected,
 * falling back to server-side rendering otherwise.
 */
export declare function exportCanvas(wss: CanvasWebSocketServer, filePath: string): Promise<{
    ok: true;
    path: string;
    elementCount: number;
} | {
    error: string;
}>;
//# sourceMappingURL=export.d.ts.map