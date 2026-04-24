/**
 * @file Intent API for Napkin — high-level drawing tools.
 *
 * Agents describe what they want, the server handles where and how.
 * No coordinates, no JSON construction, no Excalidraw internals.
 */
const NODE_DEFAULTS = {
    strokeColor: "#1e1e1e",
    backgroundColor: "#a5d8ff",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roundness: { type: 3 },
    roughness: 0,
    opacity: 100,
};
const ARROW_DEFAULTS = {
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roundness: { type: 2 },
    roughness: 0,
    opacity: 100,
};
const TEXT_DEFAULTS = {
    fontSize: 16,
    fontFamily: 5,
    textAlign: "center",
    verticalAlign: "middle",
    autoResize: true,
    lineHeight: 1.25,
};
const LABEL_DEFAULTS = {
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    fontSize: 14,
    fontFamily: 5,
    textAlign: "left",
    verticalAlign: "top",
    autoResize: true,
    lineHeight: 1.25,
};
const DEFAULT_NODE_WIDTH = 160;
const DEFAULT_NODE_HEIGHT = 60;
const NODE_PADDING = 24;
const NODE_TEXT_HORIZONTAL_PADDING = 10;
const NODE_TEXT_VERTICAL_PADDING = 24;
const SPACING = 90;
const CONNECT_GAP = 1;
const CONNECT_VERTICAL_BIAS = 2.5;
/**
 * Estimate text width in pixels. Rough approximation since we don't have
 * browser font metrics. Uses average character width for fontFamily 5.
 */
function estimateTextWidth(text, fontSize) {
    // Average character width is roughly 0.55× fontSize for Excalidraw's default font.
    return text.length * fontSize * 0.55;
}
export function estimateWrappedLineCount(text, innerWidth, avgCharWidthPx) {
    const safeInnerWidth = Math.max(1, innerWidth);
    const segments = text.split("\n");
    let totalLines = 0;
    for (const segment of segments) {
        const wrapped = Math.max(1, Math.ceil((segment.length * avgCharWidthPx) / safeInnerWidth));
        totalLines += wrapped;
    }
    return totalLines;
}
export function estimateTextContainerHeight(text, innerWidth, fontSize, lineHeightFactor, minHeight, verticalPadding, avgCharWidthFactor = 0.55) {
    const avgCharWidthPx = fontSize * avgCharWidthFactor;
    const lines = estimateWrappedLineCount(text, innerWidth, avgCharWidthPx);
    const lineHeightPx = fontSize * lineHeightFactor;
    return Math.max(minHeight, Math.ceil(lines * lineHeightPx) + verticalPadding);
}
/** Generate a fractional index for element ordering. */
let indexCounter = Date.now() % 100000;
function genIndex(_elements) {
    indexCounter++;
    return `a${indexCounter.toString(36)}`;
}
// Export for use in other modules.
export { genIndex };
/** Generate a random ID. */
function genId() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < 20; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
/** Find open space on the canvas for a new element. */
function findOpenSpace(elements, width, height, nearId) {
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
    if (elements.length === 0)
        return { x: 100, y: 100 };
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
function overlapsAny(elements, x, y, w, h) {
    return elements.some((el) => x < el.x + el.width && x + w > el.x && y < el.y + el.height && y + h > el.y);
}
/** Map shape name to Excalidraw type. */
function shapeType(shape) {
    if (shape === "ellipse" || shape === "circle")
        return "ellipse";
    if (shape === "diamond")
        return "diamond";
    return "rectangle";
}
/** Map style presets to element properties. */
function applyStyle(style) {
    const result = {};
    if (!style)
        return result;
    if (style.color)
        result.strokeColor = style.color;
    if (style.fill || style.background)
        result.backgroundColor = style.fill ?? style.background;
    if (style.strokeColor)
        result.strokeColor = style.strokeColor;
    if (style.backgroundColor)
        result.backgroundColor = style.backgroundColor;
    if (style.opacity !== undefined)
        result.opacity = style.opacity;
    if (style.strokeStyle)
        result.strokeStyle = style.strokeStyle;
    if (style.strokeWidth)
        result.strokeWidth = style.strokeWidth;
    return result;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Add a labeled node to the canvas. Server handles placement.
 */
export function addNode(wss, label, shape, style, near, metadata, originSessionId, zone, row) {
    const elements = wss.getCanvasElements();
    const nodeId = genId();
    const textId = genId();
    const type = shapeType(shape);
    // Auto-expand container to fit label text.
    const textWidth = estimateTextWidth(label, TEXT_DEFAULTS.fontSize);
    const minWidth = textWidth + NODE_PADDING * 2;
    const w = Math.max(DEFAULT_NODE_WIDTH, Math.ceil(minWidth / 10) * 10);
    const h = estimateTextContainerHeight(label, w - NODE_TEXT_HORIZONTAL_PADDING * 2, TEXT_DEFAULTS.fontSize, TEXT_DEFAULTS.lineHeight, DEFAULT_NODE_HEIGHT, NODE_TEXT_VERTICAL_PADDING);
    const textLineCount = estimateWrappedLineCount(label, w - NODE_TEXT_HORIZONTAL_PADDING * 2, TEXT_DEFAULTS.fontSize * 0.55);
    const textHeight = Math.max(20, Math.ceil(textLineCount * TEXT_DEFAULTS.fontSize * TEXT_DEFAULTS.lineHeight));
    const pos = findOpenSpace(elements, w, h, near);
    const now = Date.now();
    const styleOverrides = applyStyle(style);
    const node = {
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
        ...(() => {
            const customData = { ...(metadata ?? {}) };
            if (zone !== undefined)
                customData.zone = zone;
            if (row !== undefined)
                customData.row = row;
            return Object.keys(customData).length > 0 ? { customData } : {};
        })(),
    };
    const textEl = {
        id: textId,
        type: "text",
        x: pos.x + NODE_TEXT_HORIZONTAL_PADDING,
        y: pos.y + h / 2 - textHeight / 2,
        width: w - NODE_TEXT_HORIZONTAL_PADDING * 2,
        height: textHeight,
        strokeColor: styleOverrides.strokeColor ?? NODE_DEFAULTS.strokeColor,
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
    wss.updateCanvas([node, textEl], originSessionId);
    return nodeId;
}
/**
 * Connect two nodes with an arrow. Server computes binding points.
 */
export function resolveConnectionRouting(fromCx, fromCy, toCx, toCy) {
    const horizontalDistance = Math.abs(toCx - fromCx);
    const verticalDistance = Math.abs(toCy - fromCy);
    const useVertical = verticalDistance * CONNECT_VERTICAL_BIAS >= horizontalDistance;
    if (useVertical && toCy >= fromCy)
        return { useVertical: true, sourceSide: "bottom", targetSide: "top" };
    if (useVertical && toCy < fromCy)
        return { useVertical: true, sourceSide: "top", targetSide: "bottom" };
    if (toCx >= fromCx)
        return { useVertical: false, sourceSide: "right", targetSide: "left" };
    return { useVertical: false, sourceSide: "left", targetSide: "right" };
}
export function resolveArrowGeometry(fromRect, toRect, gap = CONNECT_GAP) {
    const fromCx = fromRect.x + fromRect.width / 2;
    const fromCy = fromRect.y + fromRect.height / 2;
    const toCx = toRect.x + toRect.width / 2;
    const toCy = toRect.y + toRect.height / 2;
    const routing = resolveConnectionRouting(fromCx, fromCy, toCx, toCy);
    let startX;
    let startY;
    let endX;
    let endY;
    if (!routing.useVertical) {
        if (routing.sourceSide === "right") {
            startX = fromRect.x + fromRect.width + gap;
            startY = fromCy;
            endX = toRect.x - gap;
            endY = toCy;
        }
        else {
            startX = fromRect.x - gap;
            startY = fromCy;
            endX = toRect.x + toRect.width + gap;
            endY = toCy;
        }
    }
    else if (routing.sourceSide === "bottom") {
        startX = fromCx;
        startY = fromRect.y + fromRect.height + gap;
        endX = toCx;
        endY = toRect.y - gap;
    }
    else {
        startX = fromCx;
        startY = fromRect.y - gap;
        endX = toCx;
        endY = toRect.y + toRect.height + gap;
    }
    return {
        startX,
        startY,
        endX,
        endY,
        dx: endX - startX,
        dy: endY - startY,
    };
}
export function connect(wss, fromId, toId, label, originSessionId) {
    const elements = wss.getCanvasElements();
    const fromEl = elements.find((el) => el.id === fromId);
    const toEl = elements.find((el) => el.id === toId);
    if (!fromEl)
        return { error: `Element "${fromId}" not found.` };
    if (!toEl)
        return { error: `Element "${toId}" not found.` };
    const arrowId = genId();
    const now = Date.now();
    // Compute directional edge-to-edge geometry so arrows render correctly on arrival.
    // Keep bindings so Excalidraw can still re-anchor on subsequent node moves.
    const fromCx = fromEl.x + fromEl.width / 2;
    const fromCy = fromEl.y + fromEl.height / 2;
    const geometry = resolveArrowGeometry({ x: fromEl.x, y: fromEl.y, width: fromEl.width, height: fromEl.height }, { x: toEl.x, y: toEl.y, width: toEl.width, height: toEl.height }, CONNECT_GAP);
    const startX = geometry.startX;
    const startY = geometry.startY;
    const endX = geometry.endX;
    const endY = geometry.endY;
    const arrowX = startX;
    const arrowY = startY;
    const dx = geometry.dx;
    const dy = geometry.dy;
    const boundElements = [];
    const arrowEls = [];
    // Optional label on the arrow.
    if (label) {
        const labelId = genId();
        boundElements.push({ id: labelId, type: "text" });
        const labelWidth = Math.max(80, estimateTextWidth(label, 14) + 10);
        const labelHeight = 20;
        const labelEl = {
            id: labelId,
            type: "text",
            x: arrowX + dx / 2 - labelWidth / 2,
            y: arrowY + dy / 2 - labelHeight / 2,
            width: labelWidth,
            height: labelHeight,
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
    const arrow = {
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
        customData: {
            from: fromId,
            to: toId,
        },
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
    ], originSessionId);
    wss.updateCanvas(arrowEls, originSessionId);
    return arrowId;
}
/**
 * Move an element by a relative offset.
 */
export function move(wss, id, dx, dy, originSessionId) {
    const el = wss.getCanvasElements().find((e) => e.id === id);
    if (!el)
        return { error: `Element "${id}" not found.` };
    // Move the element and any bound text.
    const patches = [
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
    wss.patchCanvas(patches, originSessionId);
    return { ok: true };
}
/**
 * Resize an element. Maintains center position.
 */
export function resize(wss, id, width, height, originSessionId) {
    const el = wss.getCanvasElements().find((e) => e.id === id);
    if (!el)
        return { error: `Element "${id}" not found.` };
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
        }], originSessionId);
    return { ok: true };
}
/**
 * Apply style changes to an element. Thin wrapper over patchCanvas.
 */
export function styleElement(wss, id, style, originSessionId) {
    const el = wss.getCanvasElements().find((e) => e.id === id);
    if (!el)
        return { error: `Element "${id}" not found.` };
    wss.patchCanvas([{ id, ...applyStyle(style) }], originSessionId);
    return { ok: true };
}
/**
 * Add a floating text label near an element.
 */
export function addLabel(wss, text, nearId, metadata, originSessionId) {
    const elements = wss.getCanvasElements();
    const ref = elements.find((el) => el.id === nearId);
    if (!ref)
        return { error: `Element "${nearId}" not found.` };
    const labelId = genId();
    const now = Date.now();
    const labelWidth = Math.max(100, estimateTextWidth(text, LABEL_DEFAULTS.fontSize) + 10);
    const labelHeight = 20;
    // Find non-overlapping position near the reference element.
    const pos = findOpenSpace(elements, labelWidth, labelHeight, nearId);
    const label = {
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
    wss.updateCanvas([label], originSessionId);
    return labelId;
}
/**
 * Delete an element and its bound text.
 */
export function deleteElement(wss, id, originSessionId) {
    const el = wss.getCanvasElements().find((e) => e.id === id);
    if (!el)
        return { error: `Element "${id}" not found.` };
    const patches = [{ id, isDeleted: true }];
    if (el.boundElements) {
        for (const bound of el.boundElements) {
            patches.push({ id: bound.id, isDeleted: true });
        }
    }
    wss.patchCanvas(patches, originSessionId);
    return { ok: true };
}
//# sourceMappingURL=intent.js.map