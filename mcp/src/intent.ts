/**
 * @file Intent API for Napkin — high-level drawing tools.
 *
 * Agents describe what they want, the server handles where and how.
 * No coordinates, no JSON construction, no Excalidraw internals.
 */

import type { ExcalidrawElement } from "./types.js";
import type { CanvasWebSocketServer } from "./websocket.js";

const NODE_DEFAULTS = {
  strokeColor: "#1e1e1e",
  backgroundColor: "#a5d8ff",
  fillStyle: "solid" as const,
  strokeWidth: 2,
  strokeStyle: "solid" as const,
  roundness: { type: 3 },
  roughness: 0,
  opacity: 100,
};

const ARROW_DEFAULTS = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid" as const,
  strokeWidth: 2,
  strokeStyle: "solid" as const,
  roundness: { type: 2 },
  roughness: 0,
  opacity: 100,
};

const TEXT_DEFAULTS = {
  fontSize: 16,
  fontFamily: 5,
  textAlign: "center" as const,
  verticalAlign: "middle" as const,
  autoResize: true,
  lineHeight: 1.25,
};

const LABEL_DEFAULTS = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid" as const,
  strokeWidth: 1,
  strokeStyle: "solid" as const,
  roughness: 0,
  opacity: 100,
  fontSize: 14,
  fontFamily: 5,
  textAlign: "left" as const,
  verticalAlign: "top" as const,
  autoResize: true,
  lineHeight: 1.25,
};

const DEFAULT_NODE_WIDTH = 160;
const DEFAULT_NODE_HEIGHT = 60;
const NODE_PADDING = 24;
const SPACING = 90;
const CONNECT_GAP = 1;

/**
 * Estimate text width in pixels. Rough approximation since we don't have
 * browser font metrics. Uses average character width for fontFamily 5.
 */
function estimateTextWidth(text: string, fontSize: number): number {
  // Average character width is roughly 0.55× fontSize for Excalidraw's default font.
  return text.length * fontSize * 0.55;
}

/** Generate a fractional index for element ordering. */
let indexCounter = Date.now() % 100000;
function genIndex(_elements: ExcalidrawElement[]): string {
  indexCounter++;
  return `a${indexCounter.toString(36)}`;
}

// Export for use in other modules.
export { genIndex };

/** Generate a random ID. */
function genId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 20; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** Find open space on the canvas for a new element. */
function findOpenSpace(
  elements: ExcalidrawElement[],
  width: number,
  height: number,
  nearId?: string
): { x: number; y: number } {
  if (nearId) {
    const ref = elements.find((el) => el.id === nearId);
    if (ref) {
      // Place to the right of the reference element.
      const x = ref.x + ref.width + SPACING;
      const y = ref.y;
      if (!overlapsAny(elements, x, y, width, height)) {
        return { x, y };
      }
      // Try below.
      const x2 = ref.x;
      const y2 = ref.y + ref.height + SPACING;
      if (!overlapsAny(elements, x2, y2, width, height)) {
        return { x: x2, y: y2 };
      }
    }
  }
  // Find the rightmost edge of all elements and place after it.
  if (elements.length === 0) return { x: 100, y: 100 };
  let maxRight = -Infinity;
  let yAtMax = 100;
  for (const el of elements) {
    const right = el.x + el.width;
    if (right > maxRight) {
      maxRight = right;
      yAtMax = el.y;
    }
  }
  return { x: maxRight + SPACING, y: yAtMax };
}

/** Check if a rectangle overlaps any existing element. */
function overlapsAny(
  elements: ExcalidrawElement[],
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  return elements.some((el) =>
    x < el.x + el.width && x + w > el.x && y < el.y + el.height && y + h > el.y
  );
}

/** Map shape name to Excalidraw type. */
function shapeType(shape?: string): string {
  if (shape === "ellipse" || shape === "circle") return "ellipse";
  if (shape === "diamond") return "diamond";
  return "rectangle";
}

/** Map style presets to element properties. */
function applyStyle(
  style?: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!style) return result;
  if (style.color) result.strokeColor = style.color;
  if (style.fill || style.background) result.backgroundColor = style.fill ?? style.background;
  if (style.strokeColor) result.strokeColor = style.strokeColor;
  if (style.backgroundColor) result.backgroundColor = style.backgroundColor;
  if (style.opacity !== undefined) result.opacity = style.opacity;
  if (style.strokeStyle) result.strokeStyle = style.strokeStyle;
  if (style.strokeWidth) result.strokeWidth = style.strokeWidth;
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a labeled node to the canvas. Server handles placement.
 */
export function addNode(
  wss: CanvasWebSocketServer,
  label: string,
  shape?: string,
  style?: Record<string, unknown>,
  near?: string,
  metadata?: Record<string, unknown>
): string {
  const elements = wss.getCanvasElements();
  const nodeId = genId();
  const textId = genId();
  const type = shapeType(shape);
  // Auto-expand container to fit label text.
  const textWidth = estimateTextWidth(label, TEXT_DEFAULTS.fontSize);
  const minWidth = textWidth + NODE_PADDING * 2;
  const w = Math.max(DEFAULT_NODE_WIDTH, Math.ceil(minWidth / 10) * 10);
  const h = DEFAULT_NODE_HEIGHT;
  const pos = findOpenSpace(elements, w, h, near);
  const now = Date.now();
  const styleOverrides = applyStyle(style);
  const node: ExcalidrawElement = {
    id: nodeId,
    type,
    x: pos.x,
    y: pos.y,
    width: w,
    height: h,
    ...NODE_DEFAULTS,
    ...styleOverrides,
    angle: 0,
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 100000),
    index: genIndex(wss.getCanvasElements()),
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: [{ id: textId, type: "text" }],
    updated: now,
    link: null,
    locked: false,
    startBinding: null,
    endBinding: null,
    ...(metadata && Object.keys(metadata).length > 0 ? { customData: metadata } : {}),
  };
  const textEl: ExcalidrawElement = {
    id: textId,
    type: "text",
    x: pos.x + 10,
    y: pos.y + h / 2 - 10,
    width: w - 20,
    height: 20,
    strokeColor: styleOverrides.strokeColor as string ?? NODE_DEFAULTS.strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roundness: null,
    roughness: 0,
    opacity: 100,
    angle: 0,
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 100000),
    index: genIndex(wss.getCanvasElements()),
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    text: label,
    originalText: label,
    ...TEXT_DEFAULTS,
    containerId: nodeId,
    startBinding: null,
    endBinding: null,
  };
  wss.updateCanvas([node, textEl]);
  return nodeId;
}

/**
 * Connect two nodes with an arrow. Server computes binding points.
 */
export function connect(
  wss: CanvasWebSocketServer,
  fromId: string,
  toId: string,
  label?: string
): string | { error: string } {
  const elements = wss.getCanvasElements();
  const fromEl = elements.find((el) => el.id === fromId);
  const toEl = elements.find((el) => el.id === toId);
  if (!fromEl) return { error: `Element "${fromId}" not found.` };
  if (!toEl) return { error: `Element "${toId}" not found.` };
  const arrowId = genId();
  const now = Date.now();
  // Compute directional edge-to-edge geometry so arrows render correctly on arrival.
  // Keep bindings so Excalidraw can still re-anchor on subsequent node moves.
  const fromCx = fromEl.x + fromEl.width / 2;
  const fromCy = fromEl.y + fromEl.height / 2;
  const toCx = toEl.x + toEl.width / 2;
  const toCy = toEl.y + toEl.height / 2;
  const horizontalDistance = Math.abs(toCx - fromCx);
  const verticalDistance = Math.abs(toCy - fromCy);
  let startX: number;
  let startY: number;
  let endX: number;
  let endY: number;
  if (horizontalDistance >= verticalDistance) {
    if (toCx >= fromCx) {
      startX = fromEl.x + fromEl.width + CONNECT_GAP;
      startY = fromCy;
      endX = toEl.x - CONNECT_GAP;
      endY = toCy;
    } else {
      startX = fromEl.x - CONNECT_GAP;
      startY = fromCy;
      endX = toEl.x + toEl.width + CONNECT_GAP;
      endY = toCy;
    }
  } else if (toCy >= fromCy) {
    startX = fromCx;
    startY = fromEl.y + fromEl.height + CONNECT_GAP;
    endX = toCx;
    endY = toEl.y - CONNECT_GAP;
  } else {
    startX = fromCx;
    startY = fromEl.y - CONNECT_GAP;
    endX = toCx;
    endY = toEl.y + toEl.height + CONNECT_GAP;
  }
  const arrowX = startX;
  const arrowY = startY;
  const dx = endX - startX;
  const dy = endY - startY;
  const boundElements: Array<{ id: string; type: string }> = [];
  const arrowEls: ExcalidrawElement[] = [];
  // Optional label on the arrow.
  if (label) {
    const labelId = genId();
    boundElements.push({ id: labelId, type: "text" });
    const labelEl: ExcalidrawElement = {
      id: labelId,
      type: "text",
      x: arrowX + dx / 2 - 40,
      y: arrowY + dy / 2 - 10,
      width: 80,
      height: 20,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roundness: null,
      roughness: 0,
      opacity: 100,
      angle: 0,
      seed: Math.floor(Math.random() * 100000),
      version: 1,
      versionNonce: Math.floor(Math.random() * 100000),
      index: null,
      isDeleted: false,
      groupIds: [],
      frameId: null,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
      text: label,
      originalText: label,
      ...TEXT_DEFAULTS,
      fontSize: 14,
      containerId: arrowId,
      startBinding: null,
      endBinding: null,
    };
    arrowEls.push(labelEl);
  }
  const arrow: ExcalidrawElement = {
    id: arrowId,
    type: "arrow",
    x: arrowX,
    y: arrowY,
    width: Math.abs(dx),
    height: Math.abs(dy),
    ...ARROW_DEFAULTS,
    angle: 0,
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 100000),
    index: genIndex(wss.getCanvasElements()),
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: boundElements.length > 0 ? boundElements : null,
    updated: now,
    link: null,
    locked: false,
    points: [[0, 0], [dx, dy]],
    lastCommittedPoint: null,
    startBinding: { elementId: fromId, focus: 0, gap: CONNECT_GAP },
    endBinding: { elementId: toId, focus: 0, gap: CONNECT_GAP },
    startArrowhead: null,
    endArrowhead: "arrow",
    elbowed: false,
  };
  arrowEls.unshift(arrow);
  // Also update the source/target elements' boundElements to include this arrow.
  const fromBound = [...(fromEl.boundElements ?? []), { id: arrowId, type: "arrow" }];
  const toBound = [...(toEl.boundElements ?? []), { id: arrowId, type: "arrow" }];
  wss.patchCanvas([
    { id: fromId, boundElements: fromBound },
    { id: toId, boundElements: toBound },
  ]);
  wss.updateCanvas(arrowEls);
  return arrowId;
}

/**
 * Move an element by a relative offset.
 */
export function move(
  wss: CanvasWebSocketServer,
  id: string,
  dx: number,
  dy: number
): { ok: true } | { error: string } {
  const el = wss.getCanvasElements().find((e) => e.id === id);
  if (!el) return { error: `Element "${id}" not found.` };
  // Move the element and any bound text.
  const patches: Array<Record<string, unknown>> = [
    { id, x: el.x + dx, y: el.y + dy },
  ];
  if (el.boundElements) {
    for (const bound of el.boundElements) {
      if (bound.type === "text") {
        const textEl = wss.getCanvasElements().find((e) => e.id === bound.id);
        if (textEl) {
          patches.push({ id: bound.id, x: textEl.x + dx, y: textEl.y + dy });
        }
      }
    }
  }
  wss.patchCanvas(patches);
  return { ok: true };
}

/**
 * Resize an element. Maintains center position.
 */
export function resize(
  wss: CanvasWebSocketServer,
  id: string,
  width?: number,
  height?: number
): { ok: true } | { error: string } {
  const el = wss.getCanvasElements().find((e) => e.id === id);
  if (!el) return { error: `Element "${id}" not found.` };
  const newW = width ?? el.width;
  const newH = height ?? el.height;
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  wss.patchCanvas([{
    id,
    x: cx - newW / 2,
    y: cy - newH / 2,
    width: newW,
    height: newH,
  }]);
  return { ok: true };
}

/**
 * Apply style changes to an element. Thin wrapper over patchCanvas.
 */
export function styleElement(
  wss: CanvasWebSocketServer,
  id: string,
  style: Record<string, unknown>
): { ok: true } | { error: string } {
  const el = wss.getCanvasElements().find((e) => e.id === id);
  if (!el) return { error: `Element "${id}" not found.` };
  wss.patchCanvas([{ id, ...applyStyle(style) }]);
  return { ok: true };
}

/**
 * Add a floating text label near an element.
 */
export function addLabel(
  wss: CanvasWebSocketServer,
  text: string,
  nearId: string,
  metadata?: Record<string, unknown>
): string | { error: string } {
  const elements = wss.getCanvasElements();
  const ref = elements.find((el) => el.id === nearId);
  if (!ref) return { error: `Element "${nearId}" not found.` };
  const labelId = genId();
  const now = Date.now();
  const labelWidth = Math.max(100, estimateTextWidth(text, LABEL_DEFAULTS.fontSize) + 10);
  const labelHeight = 20;
  // Find non-overlapping position near the reference element.
  const pos = findOpenSpace(elements, labelWidth, labelHeight, nearId);
  const label: ExcalidrawElement = {
    id: labelId,
    type: "text",
    x: pos.x,
    y: pos.y,
    width: labelWidth,
    height: labelHeight,
    ...LABEL_DEFAULTS,
    angle: 0,
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 100000),
    index: genIndex(wss.getCanvasElements()),
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    text,
    originalText: text,
    containerId: null,
    startBinding: null,
    endBinding: null,
    ...(metadata && Object.keys(metadata).length > 0 ? { customData: metadata } : {}),
  };
  wss.updateCanvas([label]);
  return labelId;
}

/**
 * Delete an element and its bound text.
 */
export function deleteElement(
  wss: CanvasWebSocketServer,
  id: string
): { ok: true } | { error: string } {
  const el = wss.getCanvasElements().find((e) => e.id === id);
  if (!el) return { error: `Element "${id}" not found.` };
  const patches: Array<Record<string, unknown>> = [{ id, isDeleted: true }];
  if (el.boundElements) {
    for (const bound of el.boundElements) {
      patches.push({ id: bound.id, isDeleted: true });
    }
  }
  wss.patchCanvas(patches);
  return { ok: true };
}
