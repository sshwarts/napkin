/**
 * @file Thought bubble protocol for Napkin.
 *
 * Creates, confirms, and dismisses thought bubble elements on the canvas.
 * Thought bubbles are visually distinct (dashed, purple, translucent) and
 * positioned to avoid overlapping existing elements.
 */

import type { ExcalidrawElement } from "./types.js";
import type { CanvasWebSocketServer } from "./websocket.js";
import { genIndex } from "./intent.js";

/** Thought bubble visual style constants. */
const THOUGHT_STYLE = {
  strokeStyle: "dashed",
  strokeColor: "#8B5CF6",
  backgroundColor: "#EDE9FE",
  opacity: 60,
  roughness: 0,
  strokeWidth: 2,
  fillStyle: "solid",
} as const;

/** Confirmed element style — solid, fully opaque. */
const CONFIRMED_STYLE = {
  strokeStyle: "solid",
  opacity: 100,
} as const;

const BUBBLE_WIDTH = 250;
const BUBBLE_HEIGHT = 60;
const TEXT_PADDING = 10;
const OFFSET_FROM_NODE = 50;

/** Generate a random ID matching Excalidraw's format. */
function generateId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 20; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** Check if two bounding boxes overlap. */
function overlaps(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/**
 * Find a position for a new thought bubble that doesn't overlap existing elements.
 */
function findPosition(
  elements: ExcalidrawElement[],
  nearNodeId?: string
): { x: number; y: number } {
  let baseX = 50;
  let baseY = 50;
  if (nearNodeId) {
    const node = elements.find((el) => el.id === nearNodeId);
    if (node) {
      baseX = node.x + node.width + OFFSET_FROM_NODE;
      baseY = node.y;
    }
  } else {
    // Place below the lowest element on the canvas.
    let maxBottom = 0;
    for (const el of elements) {
      const bottom = el.y + el.height;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    baseX = 50;
    baseY = maxBottom + OFFSET_FROM_NODE;
  }
  // Nudge down until no overlap.
  let candidateX = baseX;
  let candidateY = baseY;
  let attempts = 0;
  while (attempts < 20) {
    const hasOverlap = elements.some((el) =>
      overlaps(candidateX, candidateY, BUBBLE_WIDTH, BUBBLE_HEIGHT, el.x, el.y, el.width, el.height)
    );
    if (!hasOverlap) break;
    candidateY += BUBBLE_HEIGHT + 20;
    attempts++;
  }
  return { x: candidateX, y: candidateY };
}

/**
 * Create a thought bubble element pair (container + text) and push to the canvas.
 * Returns the container element's ID.
 */
export function addThoughtBubble(
  wss: CanvasWebSocketServer,
  content: string,
  nearNodeId?: string
): string {
  const elements = wss.getCanvasElements();
  const pos = findPosition(elements, nearNodeId);
  const containerId = generateId();
  const textId = generateId();
  const now = Date.now();
  const prefixedContent = `\u{1F4AD} ${content}`;
  const container: ExcalidrawElement = {
    id: containerId,
    type: "rectangle",
    x: pos.x,
    y: pos.y,
    width: BUBBLE_WIDTH,
    height: BUBBLE_HEIGHT,
    ...THOUGHT_STYLE,
    angle: 0,
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 100000),
    index: genIndex([]),
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: [{ id: textId, type: "text" }],
    updated: now,
    link: null,
    locked: false,
    roundness: { type: 3 },
    startBinding: null,
    endBinding: null,
  };
  const textEl: ExcalidrawElement = {
    id: textId,
    type: "text",
    x: pos.x + TEXT_PADDING,
    y: pos.y + BUBBLE_HEIGHT / 2 - 10,
    width: BUBBLE_WIDTH - TEXT_PADDING * 2,
    height: 20,
    strokeColor: THOUGHT_STYLE.strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roundness: null,
    roughness: 0,
    opacity: THOUGHT_STYLE.opacity,
    angle: 0,
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 100000),
    index: genIndex([]),
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    text: prefixedContent,
    originalText: prefixedContent,
    fontSize: 14,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    containerId,
    autoResize: true,
    lineHeight: 1.25,
    startBinding: null,
    endBinding: null,
  };
  wss.updateCanvas([container, textEl]);
  return containerId;
}

/**
 * Confirm a thought bubble — convert to permanent element.
 * Removes dashed style, removes emoji prefix, sets opacity to 100.
 */
export function confirmThoughtBubble(
  wss: CanvasWebSocketServer,
  bubbleId: string
): boolean {
  const elements = wss.getCanvasElements();
  const container = elements.find((el) => el.id === bubbleId);
  if (!container) return false;
  // Find the bound text element.
  const textBound = container.boundElements?.find((b) => b.type === "text");
  const textEl = textBound ? elements.find((el) => el.id === textBound.id) : undefined;
  const updatedContainer: ExcalidrawElement = {
    ...container,
    ...CONFIRMED_STYLE,
    version: (container.version as number ?? 1) + 1,
    updated: Date.now(),
  };
  const updates: ExcalidrawElement[] = [updatedContainer];
  if (textEl) {
    let cleanText = textEl.text ?? "";
    // Remove thought bubble emoji prefix.
    cleanText = cleanText.replace(/^\u{1F4AD}\s*/u, "");
    updates.push({
      ...textEl,
      text: cleanText,
      originalText: cleanText,
      opacity: 100,
      version: (textEl.version as number ?? 1) + 1,
      updated: Date.now(),
    });
  }
  wss.updateCanvas(updates);
  return true;
}

/**
 * Dismiss (delete) a thought bubble from the canvas.
 */
export function dismissThoughtBubble(
  wss: CanvasWebSocketServer,
  bubbleId: string
): boolean {
  const elements = wss.getCanvasElements();
  const container = elements.find((el) => el.id === bubbleId);
  if (!container) return false;
  // Mark container as deleted.
  const updates: ExcalidrawElement[] = [
    { ...container, isDeleted: true, version: (container.version as number ?? 1) + 1, updated: Date.now() },
  ];
  // Also delete the bound text element.
  const textBound = container.boundElements?.find((b) => b.type === "text");
  if (textBound) {
    const textEl = elements.find((el) => el.id === textBound.id);
    if (textEl) {
      updates.push({
        ...textEl,
        isDeleted: true,
        version: (textEl.version as number ?? 1) + 1,
        updated: Date.now(),
      });
    }
  }
  wss.updateCanvas(updates);
  return true;
}

/**
 * List all current thought bubbles on the canvas.
 */
export function listThoughtBubbles(
  wss: CanvasWebSocketServer
): Array<{ id: string; content: string; nearNodeId?: string }> {
  const elements = wss.getCanvasElements().filter((el) => !el.isDeleted);
  const results: Array<{ id: string; content: string; nearNodeId?: string }> = [];
  for (const el of elements) {
    if (
      el.strokeStyle === "dashed" &&
      el.strokeColor?.toUpperCase() === "#8B5CF6" &&
      el.type !== "arrow"
    ) {
      // Find text content.
      let content = "";
      const textBound = el.boundElements?.find((b) => b.type === "text");
      if (textBound) {
        const textEl = elements.find((t) => t.id === textBound.id);
        content = textEl?.text ?? "";
      }
      results.push({ id: el.id, content });
    }
  }
  return results;
}
