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

import { writeFile, mkdir } from "node:fs/promises";
import { extname, join, dirname, isAbsolute } from "node:path";
import type { ExcalidrawElement } from "./types.js";
import type { CanvasWebSocketServer } from "./websocket.js";
import { renderElementsToSvg } from "./sketch.js";

const EXPORT_DIR = process.env.NAPKIN_EXPORT_DIR ?? "";

/**
 * Resolve the export file path.
 * If NAPKIN_EXPORT_DIR is set and the path is not absolute, prepend it.
 */
function resolveExportPath(filePath: string): string {
  if (isAbsolute(filePath)) return filePath;
  if (EXPORT_DIR) return join(EXPORT_DIR, filePath);
  return filePath;
}

/**
 * Export the current canvas to a file.
 * Format is inferred from the file extension.
 * SVG/PNG use browser-side rendering when a browser is connected,
 * falling back to server-side rendering otherwise.
 */
export async function exportCanvas(
  wss: CanvasWebSocketServer,
  filePath: string
): Promise<{ ok: true; path: string; elementCount: number } | { error: string }> {
  filePath = resolveExportPath(filePath);
  const elements = wss.getCanvasElements().filter(
    (el) => !el.isDeleted
  );
  if (elements.length === 0) {
    return { error: "Canvas is empty — nothing to export." };
  }
  await mkdir(dirname(filePath), { recursive: true });
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".excalidraw":
    case ".json":
      return exportExcalidraw(elements, filePath);
    case ".svg":
      return exportVisual(wss, elements, filePath, "svg");
    case ".png":
      return exportVisual(wss, elements, filePath, "png");
    default:
      return { error: `Unsupported format "${ext}". Use .excalidraw, .svg, or .png.` };
  }
}

async function exportExcalidraw(
  elements: ExcalidrawElement[],
  filePath: string
): Promise<{ ok: true; path: string; elementCount: number }> {
  const doc = {
    type: "excalidraw",
    version: 2,
    source: "napkin",
    elements,
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
  await writeFile(filePath, JSON.stringify(doc, null, 2), "utf-8");
  return { ok: true, path: filePath, elementCount: elements.length };
}

/**
 * Export via browser when available, fall back to server-side SVG rendering.
 */
async function exportVisual(
  wss: CanvasWebSocketServer,
  elements: ExcalidrawElement[],
  filePath: string,
  format: "svg" | "png"
): Promise<{ ok: true; path: string; elementCount: number } | { error: string }> {
  // Try browser-side export first (pixel-perfect).
  if (wss.getClientCount() > 0) {
    const result = await wss.requestExport(format);
    if ("data" in result) {
      if (format === "svg") {
        await writeFile(filePath, result.data, "utf-8");
      } else {
        await writeFile(filePath, Buffer.from(result.data, "base64"));
      }
      return { ok: true, path: filePath, elementCount: elements.length };
    }
    // Browser export failed — fall through to server-side.
  }
  // Server-side fallback.
  const svg = renderElementsToSvg(elements, elements);
  if (format === "svg") {
    await writeFile(filePath, svg, "utf-8");
  } else {
    const sharp = (await import("sharp")).default;
    const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
    await writeFile(filePath, pngBuffer);
  }
  return { ok: true, path: filePath, elementCount: elements.length };
}
