/**
 * @file Thought bubble protocol for Napkin.
 *
 * Creates, confirms, and dismisses thought bubble elements on the canvas.
 * Thought bubbles are visually distinct (dashed, purple, translucent) and
 * positioned to avoid overlapping existing elements.
 */
import { genIndex, estimateTextContainerHeight, estimateWrappedLineCount } from "./intent.js";
/** Thought bubble visual style constants. */
const THOUGHT_STYLE = {
    strokeStyle: "dashed",
    strokeColor: "#8B5CF6",
    backgroundColor: "#EDE9FE",
    opacity: 60,
    roughness: 0,
    strokeWidth: 2,
    fillStyle: "solid",
};
/** Confirmed element style — solid, fully opaque. */
const CONFIRMED_STYLE = {
    strokeStyle: "solid",
    opacity: 100,
};
const BUBBLE_WIDTH = 250;
const BUBBLE_MIN_HEIGHT = 60;
const TEXT_PADDING = 10;
const BUBBLE_VERTICAL_PADDING = 24;
const OFFSET_FROM_NODE = 50;
/** Generate a random ID matching Excalidraw's format. */
function generateId() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < 20; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
/** Check if two bounding boxes overlap. */
function overlaps(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}
/**
 * Find a position for a new thought bubble that doesn't overlap existing elements.
 */
function findPosition(elements, bubbleWidth, bubbleHeight, nearNodeId) {
    let baseX = 50;
    let baseY = 50;
    if (nearNodeId) {
        const node = elements.find((el) => el.id === nearNodeId);
        if (node) {
            baseX = node.x + node.width + OFFSET_FROM_NODE;
            baseY = node.y;
        }
    }
    else {
        // Place below the lowest element on the canvas.
        let maxBottom = 0;
        for (const el of elements) {
            const bottom = el.y + el.height;
            if (bottom > maxBottom)
                maxBottom = bottom;
        }
        baseX = 50;
        baseY = maxBottom + OFFSET_FROM_NODE;
    }
    // Nudge down until no overlap.
    let candidateX = baseX;
    let candidateY = baseY;
    let attempts = 0;
    while (attempts < 20) {
        const hasOverlap = elements.some((el) => overlaps(candidateX, candidateY, bubbleWidth, bubbleHeight, el.x, el.y, el.width, el.height));
        if (!hasOverlap)
            break;
        candidateY += bubbleHeight + 20;
        attempts++;
    }
    return { x: candidateX, y: candidateY };
}
/**
 * Create a thought bubble element pair (container + text) and push to the canvas.
 * Returns the container element's ID.
 */
export function addThoughtBubble(wss, content, nearNodeId) {
    const elements = wss.getCanvasElements();
    const containerId = generateId();
    const textId = generateId();
    const now = Date.now();
    const prefixedContent = `\u{1F4AD} ${content}`;
    const textInnerWidth = BUBBLE_WIDTH - TEXT_PADDING * 2;
    const bubbleHeight = estimateTextContainerHeight(prefixedContent, textInnerWidth, 14, 1.25, BUBBLE_MIN_HEIGHT, BUBBLE_VERTICAL_PADDING);
    const textLineCount = estimateWrappedLineCount(prefixedContent, textInnerWidth, 14 * 0.55);
    const textHeight = Math.max(20, Math.ceil(textLineCount * 14 * 1.25));
    const pos = findPosition(elements, BUBBLE_WIDTH, bubbleHeight, nearNodeId);
    const container = {
        id: containerId,
        type: "rectangle",
        x: pos.x,
        y: pos.y,
        width: BUBBLE_WIDTH,
        height: bubbleHeight,
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
    const textEl = {
        id: textId,
        type: "text",
        x: pos.x + TEXT_PADDING,
        y: pos.y + bubbleHeight / 2 - textHeight / 2,
        width: BUBBLE_WIDTH - TEXT_PADDING * 2,
        height: textHeight,
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
        fontFamily: 5,
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
export function confirmThoughtBubble(wss, bubbleId) {
    const elements = wss.getCanvasElements();
    const container = elements.find((el) => el.id === bubbleId);
    if (!container)
        return false;
    // Find the bound text element.
    const textBound = container.boundElements?.find((b) => b.type === "text");
    const textEl = textBound ? elements.find((el) => el.id === textBound.id) : undefined;
    const updatedContainer = {
        ...container,
        ...CONFIRMED_STYLE,
        version: (container.version ?? 1) + 1,
        updated: Date.now(),
    };
    const updates = [updatedContainer];
    if (textEl) {
        let cleanText = textEl.text ?? "";
        // Remove thought bubble emoji prefix.
        cleanText = cleanText.replace(/^\u{1F4AD}\s*/u, "");
        updates.push({
            ...textEl,
            text: cleanText,
            originalText: cleanText,
            opacity: 100,
            version: (textEl.version ?? 1) + 1,
            updated: Date.now(),
        });
    }
    wss.updateCanvas(updates);
    return true;
}
/**
 * Dismiss (delete) a thought bubble from the canvas.
 */
export function dismissThoughtBubble(wss, bubbleId) {
    const elements = wss.getCanvasElements();
    const container = elements.find((el) => el.id === bubbleId);
    if (!container)
        return false;
    // Mark container as deleted.
    const updates = [
        { ...container, isDeleted: true, version: (container.version ?? 1) + 1, updated: Date.now() },
    ];
    // Also delete the bound text element.
    const textBound = container.boundElements?.find((b) => b.type === "text");
    if (textBound) {
        const textEl = elements.find((el) => el.id === textBound.id);
        if (textEl) {
            updates.push({
                ...textEl,
                isDeleted: true,
                version: (textEl.version ?? 1) + 1,
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
export function listThoughtBubbles(wss) {
    const elements = wss.getCanvasElements().filter((el) => !el.isDeleted);
    const results = [];
    for (const el of elements) {
        if (el.strokeStyle === "dashed" &&
            el.strokeColor?.toUpperCase() === "#8B5CF6" &&
            el.type !== "arrow") {
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
//# sourceMappingURL=thought.js.map