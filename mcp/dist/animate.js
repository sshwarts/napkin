/**
 * @file Animation engine for Napkin.
 *
 * Simulates element animation via rapid WebSocket canvas_patch messages
 * at ~30fps. The MCP server handles interpolation — no browser-side
 * animation code needed.
 */
const FRAME_INTERVAL_MS = 33; // ~30fps
/** Animatable numeric properties. */
const NUMERIC_PROPS = new Set(["x", "y", "width", "height", "opacity"]);
/** Animatable color properties (hex strings). */
const COLOR_PROPS = new Set(["strokeColor", "backgroundColor"]);
const EASING_FUNCTIONS = {
    linear: (t) => t,
    "ease-in": (t) => t * t,
    "ease-out": (t) => t * (2 - t),
};
// ---------------------------------------------------------------------------
// Color interpolation
// ---------------------------------------------------------------------------
/** Parse a hex color (#RGB or #RRGGBB) to [r, g, b]. */
function parseHex(hex) {
    const clean = hex.replace("#", "");
    if (clean.length === 3) {
        return [
            parseInt(clean[0] + clean[0], 16),
            parseInt(clean[1] + clean[1], 16),
            parseInt(clean[2] + clean[2], 16),
        ];
    }
    if (clean.length === 6) {
        return [
            parseInt(clean.slice(0, 2), 16),
            parseInt(clean.slice(2, 4), 16),
            parseInt(clean.slice(4, 6), 16),
        ];
    }
    return null;
}
/** Lerp between two hex colors. */
function lerpColor(from, to, t) {
    const a = parseHex(from);
    const b = parseHex(to);
    if (!a || !b)
        return to;
    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bVal = Math.round(a[2] + (b[2] - a[2]) * t);
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bVal.toString(16).padStart(2, "0")}`;
}
// ---------------------------------------------------------------------------
// Animation runner
// ---------------------------------------------------------------------------
/**
 * Animate a single element from its current state to the target properties.
 * Resolves when the animation completes.
 */
export function animateElement(wss, elementId, target, durationMs, easing = "linear", commit) {
    return new Promise((resolve) => {
        const elements = wss.getCanvasElements();
        const element = elements.find((el) => el.id === elementId);
        if (!element) {
            resolve({ error: `Element "${elementId}" not found.` });
            return;
        }
        const easingFn = EASING_FUNCTIONS[easing] ?? EASING_FUNCTIONS.linear;
        // Capture start values for each animatable property in the target.
        const numericAnims = [];
        const colorAnims = [];
        for (const [prop, toVal] of Object.entries(target)) {
            if (NUMERIC_PROPS.has(prop) && typeof toVal === "number") {
                const fromVal = element[prop];
                if (typeof fromVal === "number") {
                    numericAnims.push({ prop, from: fromVal, to: toVal });
                }
            }
            else if (COLOR_PROPS.has(prop) && typeof toVal === "string") {
                const fromVal = element[prop];
                if (typeof fromVal === "string") {
                    colorAnims.push({ prop, from: fromVal, to: toVal });
                }
            }
        }
        if (numericAnims.length === 0 && colorAnims.length === 0) {
            resolve({ error: "No animatable properties in target." });
            return;
        }
        const totalFrames = Math.max(1, Math.round(durationMs / FRAME_INTERVAL_MS));
        let frame = 0;
        const timer = setInterval(() => {
            frame++;
            const t = Math.min(1, frame / totalFrames);
            const easedT = easingFn(t);
            // Re-read the current element state each frame so we merge correctly.
            const currentEl = wss.getCanvasElements().find((el) => el.id === elementId);
            if (!currentEl) {
                clearInterval(timer);
                resolve({ error: `Element "${elementId}" disappeared during animation.` });
                return;
            }
            // Build the full element with interpolated properties overlaid.
            const patch = { ...currentEl };
            for (const { prop, from, to } of numericAnims) {
                patch[prop] = from + (to - from) * easedT;
            }
            for (const { prop, from, to } of colorAnims) {
                patch[prop] = lerpColor(from, to, easedT);
            }
            // On final frame, snap to exact target values and apply commit properties.
            if (frame >= totalFrames) {
                for (const { prop, to } of numericAnims) {
                    patch[prop] = to;
                }
                for (const { prop, to } of colorAnims) {
                    patch[prop] = to;
                }
                // Apply commit properties (e.g. final position, deletion) atomically.
                if (commit) {
                    for (const [key, value] of Object.entries(commit)) {
                        patch[key] = value;
                    }
                }
                clearInterval(timer);
            }
            // Bump version so Excalidraw recognizes the change.
            patch.version = (element.version ?? 1) + frame;
            patch.updated = Date.now();
            wss.updateCanvas([patch]);
            if (frame >= totalFrames) {
                resolve({ ok: true });
            }
        }, FRAME_INTERVAL_MS);
    });
}
//# sourceMappingURL=animate.js.map