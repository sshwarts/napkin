/**
 * @file Spatial analysis layer for Napkin.
 *
 * Parses raw Excalidraw element JSON into a StructuredCanvas that agents
 * can reason about — nodes, edges, zones, proximity associations, thought
 * bubbles, and freehand sketches. No coordinates exposed; only semantic
 * structure.
 */
import type { ExcalidrawElement, StructuredCanvas } from "./types.js";
/**
 * Analyze raw Excalidraw elements into a StructuredCanvas.
 */
export declare function analyzeCanvas(elements: ExcalidrawElement[]): StructuredCanvas;
//# sourceMappingURL=spatial.d.ts.map