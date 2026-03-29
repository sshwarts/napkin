/**
 * @file Visual description for Napkin — any canvas element(s).
 *
 * Renders specified elements to SVG → PNG server-side, sends to Claude
 * vision for description, creates a grouped text annotation on the canvas.
 * Works for freedraw, rectangles, ellipses, diamonds, arrows, text, and
 * multi-element groups.
 */
import Anthropic from "@anthropic-ai/sdk";
import { genIndex } from "./intent.js";
const ANNOTATION_STYLE = {
    strokeColor: "#6b7280",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 80,
};
const TEXT_OFFSET_Y = 10;
const DEFAULT_PROMPT = "Describe what this represents in one sentence. Be concise.";
const VISION_MODEL = process.env.NAPKIN_VISION_MODEL ?? "claude-haiku-4-5-20251001";
const VISION_MAX_TOKENS = parseInt(process.env.NAPKIN_VISION_MAX_TOKENS ?? "200", 10);
/** Generate a random ID matching Excalidraw's format. */
function generateId() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < 20; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
/** Escape text for safe SVG embedding. */
function escapeXml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderRectangle(el, ox, oy) {
    const rx = el.roundness ? 8 : 0;
    return `<rect x="${el.x - ox}" y="${el.y - oy}" width="${el.width}" height="${el.height}" rx="${rx}" ry="${rx}" stroke="${el.strokeColor}" stroke-width="${el.strokeWidth ?? 2}" fill="${el.backgroundColor === 'transparent' ? 'none' : el.backgroundColor}" opacity="${(el.opacity ?? 100) / 100}" stroke-dasharray="${el.strokeStyle === 'dashed' ? '8,4' : el.strokeStyle === 'dotted' ? '2,4' : 'none'}"/>`;
}
function renderEllipse(el, ox, oy) {
    const cx = el.x - ox + el.width / 2;
    const cy = el.y - oy + el.height / 2;
    return `<ellipse cx="${cx}" cy="${cy}" rx="${el.width / 2}" ry="${el.height / 2}" stroke="${el.strokeColor}" stroke-width="${el.strokeWidth ?? 2}" fill="${el.backgroundColor === 'transparent' ? 'none' : el.backgroundColor}" opacity="${(el.opacity ?? 100) / 100}"/>`;
}
function renderDiamond(el, ox, oy) {
    const x = el.x - ox;
    const y = el.y - oy;
    const mx = x + el.width / 2;
    const my = y + el.height / 2;
    const points = `${mx},${y} ${x + el.width},${my} ${mx},${y + el.height} ${x},${my}`;
    return `<polygon points="${points}" stroke="${el.strokeColor}" stroke-width="${el.strokeWidth ?? 2}" fill="${el.backgroundColor === 'transparent' ? 'none' : el.backgroundColor}" opacity="${(el.opacity ?? 100) / 100}"/>`;
}
function renderText(el, ox, oy) {
    if (!el.text)
        return "";
    const fontSize = el.fontSize ?? 16;
    const x = el.x - ox;
    const y = el.y - oy + fontSize;
    return `<text x="${x}" y="${y}" font-size="${fontSize}" font-family="sans-serif" fill="${el.strokeColor}" opacity="${(el.opacity ?? 100) / 100}">${escapeXml(el.text)}</text>`;
}
function renderArrow(el, ox, oy) {
    const points = el.points;
    if (!points || points.length < 2)
        return "";
    const baseX = el.x - ox;
    const baseY = el.y - oy;
    const pathParts = points.map(([px, py], i) => (i === 0 ? "M" : "L") + (baseX + px) + "," + (baseY + py));
    // Arrowhead at the last point.
    const [lastX, lastY] = points[points.length - 1];
    const [prevX, prevY] = points[points.length - 2];
    const angle = Math.atan2(lastY - prevY, lastX - prevX);
    const headLen = 10;
    const lx = baseX + lastX - headLen * Math.cos(angle - 0.4);
    const ly = baseY + lastY - headLen * Math.sin(angle - 0.4);
    const rx = baseX + lastX - headLen * Math.cos(angle + 0.4);
    const ry = baseY + lastY - headLen * Math.sin(angle + 0.4);
    const arrowHead = `M${lx},${ly} L${baseX + lastX},${baseY + lastY} L${rx},${ry}`;
    return `<path d="${pathParts.join(" ")}" stroke="${el.strokeColor}" stroke-width="${el.strokeWidth ?? 2}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<path d="${arrowHead}" stroke="${el.strokeColor}" stroke-width="${el.strokeWidth ?? 2}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
}
function renderFreedraw(el, ox, oy) {
    const points = el.points;
    if (!points || points.length === 0)
        return "";
    const baseX = el.x - ox;
    const baseY = el.y - oy;
    const pathParts = points.map(([px, py], i) => (i === 0 ? "M" : "L") + (baseX + px) + "," + (baseY + py));
    return `<path d="${pathParts.join(" ")}" stroke="${el.strokeColor || '#000'}" stroke-width="${el.strokeWidth ?? 2}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
}
function renderLine(el, ox, oy) {
    const points = el.points;
    if (!points || points.length < 2)
        return "";
    const baseX = el.x - ox;
    const baseY = el.y - oy;
    const pathParts = points.map(([px, py], i) => (i === 0 ? "M" : "L") + (baseX + px) + "," + (baseY + py));
    return `<path d="${pathParts.join(" ")}" stroke="${el.strokeColor}" stroke-width="${el.strokeWidth ?? 2}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
}
// ---------------------------------------------------------------------------
// Multi-element SVG scene renderer
// ---------------------------------------------------------------------------
/**
 * Render one or more Excalidraw elements to a single SVG string.
 * Also includes bound text elements (labels inside shapes).
 */
export function renderElementsToSvg(targetElements, allElements) {
    // Collect all elements to render: targets + their bound text elements.
    const targetIds = new Set(targetElements.map((el) => el.id));
    const toRender = [...targetElements];
    for (const el of targetElements) {
        if (el.boundElements) {
            for (const bound of el.boundElements) {
                if (bound.type === "text" && !targetIds.has(bound.id)) {
                    const textEl = allElements.find((e) => e.id === bound.id);
                    if (textEl) {
                        toRender.push(textEl);
                        targetIds.add(textEl.id);
                    }
                }
            }
        }
    }
    // Compute bounding box across all elements.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of toRender) {
        if (el.type === "freedraw" || el.type === "arrow" || el.type === "line") {
            const points = el.points;
            if (points) {
                for (const [px, py] of points) {
                    const absX = el.x + px;
                    const absY = el.y + py;
                    if (absX < minX)
                        minX = absX;
                    if (absY < minY)
                        minY = absY;
                    if (absX > maxX)
                        maxX = absX;
                    if (absY > maxY)
                        maxY = absY;
                }
            }
        }
        else {
            if (el.x < minX)
                minX = el.x;
            if (el.y < minY)
                minY = el.y;
            if (el.x + el.width > maxX)
                maxX = el.x + el.width;
            if (el.y + el.height > maxY)
                maxY = el.y + el.height;
        }
    }
    const padding = 20;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;
    const width = Math.ceil(maxX - minX);
    const height = Math.ceil(maxY - minY);
    // Render each element.
    const svgParts = [];
    for (const el of toRender) {
        switch (el.type) {
            case "rectangle":
                svgParts.push(renderRectangle(el, minX, minY));
                break;
            case "ellipse":
                svgParts.push(renderEllipse(el, minX, minY));
                break;
            case "diamond":
                svgParts.push(renderDiamond(el, minX, minY));
                break;
            case "text":
                svgParts.push(renderText(el, minX, minY));
                break;
            case "arrow":
                svgParts.push(renderArrow(el, minX, minY));
                break;
            case "line":
                svgParts.push(renderLine(el, minX, minY));
                break;
            case "freedraw":
                svgParts.push(renderFreedraw(el, minX, minY));
                break;
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="white"/>
  ${svgParts.join("\n  ")}
</svg>`;
}
// ---------------------------------------------------------------------------
// Vision API
// ---------------------------------------------------------------------------
/** Convert SVG string to PNG base64 using sharp. */
async function svgToPngBase64(svgString) {
    const sharp = (await import("sharp")).default;
    const pngBuffer = await sharp(Buffer.from(svgString)).png().toBuffer();
    return pngBuffer.toString("base64");
}
/** Send a PNG to Claude vision and get a description. */
async function describeWithVision(pngBase64, prompt) {
    try {
        const client = new Anthropic();
        const response = await client.messages.create({
            model: VISION_MODEL,
            max_tokens: VISION_MAX_TOKENS,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: "image/png",
                                data: pngBase64,
                            },
                        },
                        { type: "text", text: prompt },
                    ],
                },
            ],
        });
        const textBlock = response.content.find((b) => b.type === "text");
        return textBlock?.text ?? "Unable to describe elements.";
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Vision error: ${msg}`;
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Describe one or more canvas elements: render to SVG → PNG, send to vision
 * model, create a grouped text annotation on the canvas.
 */
export async function describeElements(wss, elementIds, prompt) {
    const allElements = wss.getCanvasElements();
    const targets = [];
    for (const id of elementIds) {
        const el = allElements.find((e) => e.id === id);
        if (!el)
            return { error: `Element "${id}" not found.` };
        targets.push(el);
    }
    if (targets.length === 0)
        return { error: "No element IDs provided." };
    // Render to SVG then PNG.
    const svg = renderElementsToSvg(targets, allElements);
    const pngBase64 = await svgToPngBase64(svg);
    const description = await describeWithVision(pngBase64, prompt ?? DEFAULT_PROMPT);
    // Create a text annotation grouped with the target element(s).
    const groupId = generateId();
    const textId = generateId();
    const now = Date.now();
    // Position below the bottom-most target element.
    let maxBottom = -Infinity;
    let leftMost = Infinity;
    for (const el of targets) {
        const bottom = el.y + el.height;
        if (bottom > maxBottom)
            maxBottom = bottom;
        if (el.x < leftMost)
            leftMost = el.x;
    }
    const textEl = {
        id: textId,
        type: "text",
        x: leftMost,
        y: maxBottom + TEXT_OFFSET_Y,
        width: 300,
        height: 20,
        ...ANNOTATION_STYLE,
        angle: 0,
        seed: Math.floor(Math.random() * 100000),
        version: 1,
        versionNonce: Math.floor(Math.random() * 100000),
        index: genIndex([]),
        isDeleted: false,
        groupIds: [groupId],
        frameId: null,
        boundElements: null,
        updated: now,
        link: null,
        locked: false,
        text: description,
        originalText: description,
        fontSize: 14,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        autoResize: true,
        lineHeight: 1.25,
        startBinding: null,
        endBinding: null,
    };
    // Add the groupId to all target elements so they move together.
    const updates = [textEl];
    for (const el of targets) {
        updates.push({
            ...el,
            groupIds: [...el.groupIds, groupId],
            version: (el.version ?? 1) + 1,
            updated: now,
        });
    }
    wss.updateCanvas(updates);
    return { description };
}
/**
 * Convenience wrapper: describe a single freehand sketch element.
 * Kept for backwards compatibility.
 */
export async function describeSketch(wss, elementId) {
    return describeElements(wss, [elementId]);
}
//# sourceMappingURL=sketch.js.map