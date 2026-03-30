/**
 * @file MCP tool implementations for Napkin.
 *
 * 25 tools organized by category:
 * Read: get_canvas, get_canvas_diff, get_canvas_raw, get_pending_triggers
 * Intent API: add_node, connect, move, resize, style, add_label, delete_element
 * Write: patch_canvas, update_canvas, clear_canvas
 * Layout: layout
 * Thought bubbles: add/confirm/dismiss/list_thought_bubble(s)
 * Vision: describe_elements, describe_sketch (requires API key)
 * Animation/Export: animate_element, export_canvas
 * Sessions: start_session, end_session
 */
import { z } from "zod";
import { analyzeCanvas } from "./spatial.js";
import { describeElements, describeSketch } from "./sketch.js";
import { animateElement } from "./animate.js";
import { exportCanvas } from "./export.js";
import { layoutCanvas } from "./layout.js";
import { addNode, connect, move, resize, styleElement, addLabel, deleteElement, } from "./intent.js";
import { addThoughtBubble, confirmThoughtBubble, dismissThoughtBubble, listThoughtBubbles, } from "./thought.js";
/**
 * Register all MCP tools on the given server.
 */
export function registerTools(server, wss, sessions) {
    server.tool("get_canvas", "Returns the current canvas as a spatially analyzed structured object with nodes, edges, zones, sticky notes, thought bubbles, and freehand sketches.", {
        pretty: z.boolean().optional().describe("Pretty-print JSON output for debugging (default: false)"),
    }, async ({ pretty }) => {
        const elements = wss.getCanvasElements();
        const structured = analyzeCanvas(elements);
        return {
            content: [
                {
                    type: "text",
                    text: pretty ? JSON.stringify(structured, null, 2) : JSON.stringify(structured),
                },
            ],
        };
    });
    server.tool("get_canvas_diff", "Returns only elements that changed since a given timestamp. Use to efficiently poll for updates without parsing the full canvas. The timestamp comes from a previous trigger or from Date.now() at your last read.", {
        since: z.number().describe("Epoch millisecond timestamp — returns elements where updated > since"),
        pretty: z.boolean().optional().describe("Pretty-print JSON output for debugging (default: false)"),
    }, async ({ since, pretty }) => {
        const changed = wss.getCanvasDiff(since);
        if (changed.length === 0) {
            return {
                content: [{ type: "text", text: "No changes since that timestamp." }],
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: pretty ? JSON.stringify(changed, null, 2) : JSON.stringify(changed),
                },
            ],
        };
    });
    server.tool("get_canvas_raw", "Returns the raw Excalidraw JSON for the current canvas.", {}, async () => {
        const raw = wss.getCanvasRaw();
        return {
            content: [
                {
                    type: "text",
                    text: raw,
                },
            ],
        };
    });
    server.tool("get_pending_triggers", "Return and drain all pending agent triggers (debounce or chat). Returns an array of trigger objects with source, timestamp, and optional message.", {}, async () => {
        const triggers = wss.drainTriggers();
        return {
            content: [
                {
                    type: "text",
                    text: triggers.length > 0
                        ? JSON.stringify(triggers)
                        : "No pending triggers.",
                },
            ],
        };
    });
    server.tool("clear_canvas", "Remove all elements from the canvas.", {}, async () => {
        wss.clearCanvas();
        return {
            content: [
                {
                    type: "text",
                    text: `Canvas cleared. Change broadcast to ${wss.getClientCount()} connected browser(s).`,
                },
            ],
        };
    });
    server.tool("patch_canvas", "Modify existing canvas elements without resending full definitions. Each patch is an object with an 'id' field and the fields to change. The server merges the patch with the cached element and broadcasts. Use for style changes, position tweaks, text edits — anything that modifies an existing element.", {
        patches: z.array(z.record(z.unknown())).describe("Array<{ id: string, [field]: any }>. Only include the fields you want to change. JSON-string format is no longer accepted."),
    }, async ({ patches }) => {
        if (!Array.isArray(patches)) {
            return {
                content: [{ type: "text", text: "Error: patches must be an array of patch objects." }],
                isError: true,
            };
        }
        if (patches.some((p) => typeof p !== "object" || p === null || Array.isArray(p))) {
            return {
                content: [{ type: "text", text: "Error: each patch must be an object." }],
                isError: true,
            };
        }
        const notFound = wss.patchCanvas(patches);
        const applied = patches.length - notFound.length;
        let msg = `Patched ${applied} element(s).`;
        if (notFound.length > 0) {
            msg += ` Not found: ${notFound.join(", ")}`;
        }
        return {
            content: [{ type: "text", text: msg }],
        };
    });
    server.tool("update_canvas", "Add new elements to the canvas. Requires full element definitions. For modifying existing elements, use patch_canvas instead.", {
        elements: z.array(z.record(z.unknown())).describe("Array of ExcalidrawElement objects to merge into the canvas. JSON-string format is no longer accepted."),
    }, async ({ elements }) => {
        if (!Array.isArray(elements)) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Error: elements must be an array of ExcalidrawElement objects.",
                    },
                ],
                isError: true,
            };
        }
        if (elements.some((el) => typeof el !== "object" || el === null || Array.isArray(el))) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Error: each element must be an object.",
                    },
                ],
                isError: true,
            };
        }
        wss.updateCanvas(elements);
        return {
            content: [
                {
                    type: "text",
                    text: `Updated canvas with ${elements.length} element(s). Change broadcast to ${wss.getClientCount()} connected browser(s).`,
                },
            ],
        };
    });
    // --- Intent API (high-level drawing tools) ---
    server.tool("add_node", "Add a labeled node to the canvas. Server handles placement — no coordinates needed. Returns the new element ID. Optional metadata is stored as customData (invisible in UI, returned in get_canvas). Conventions: intent, notes, status (wip|review|done|parking_lot), owner.", {
        label: z.string().describe("Text label for the node"),
        shape: z.enum(["rectangle", "ellipse", "diamond"]).optional().describe("Shape type (default: rectangle)"),
        style: z.record(z.unknown()).optional().describe("Style overrides: color, fill/background, opacity, strokeStyle, strokeWidth"),
        near: z.string().optional().describe("ID of an element to place the new node near"),
        metadata: z.record(z.unknown()).optional().describe("Non-visual metadata stored as customData. Conventions: intent, notes, status (wip|review|done|parking_lot), owner"),
    }, async ({ label, shape, style, near, metadata }) => {
        const id = addNode(wss, label, shape, style, near, metadata);
        return { content: [{ type: "text", text: `Created node "${label}" (${id})` }] };
    });
    server.tool("connect", "Connect two nodes with an arrow. Server computes binding points. Optionally add a label on the arrow.", {
        from_id: z.string().describe("Source node ID"),
        to_id: z.string().describe("Target node ID"),
        label: z.string().optional().describe("Optional label on the arrow"),
    }, async ({ from_id, to_id, label }) => {
        const result = connect(wss, from_id, to_id, label);
        if (typeof result === "object" && "error" in result) {
            return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Connected ${from_id} → ${to_id} (arrow ${result})` }] };
    });
    server.tool("move", "Move an element by a relative offset. Also moves bound text labels.", {
        id: z.string().describe("Element ID to move"),
        dx: z.number().describe("Horizontal offset in pixels (positive = right)"),
        dy: z.number().describe("Vertical offset in pixels (positive = down)"),
    }, async ({ id, dx, dy }) => {
        const result = move(wss, id, dx, dy);
        if ("error" in result) {
            return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Moved "${id}" by (${dx}, ${dy})` }] };
    });
    server.tool("resize", "Resize an element. Maintains center position.", {
        id: z.string().describe("Element ID to resize"),
        width: z.number().optional().describe("New width in pixels"),
        height: z.number().optional().describe("New height in pixels"),
    }, async ({ id, width, height }) => {
        const result = resize(wss, id, width, height);
        if ("error" in result) {
            return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Resized "${id}"${width ? ` width=${width}` : ""}${height ? ` height=${height}` : ""}` }] };
    });
    server.tool("style", "Apply style changes to an element. Accepts: color, fill/background, opacity, strokeStyle, strokeWidth.", {
        id: z.string().describe("Element ID to style"),
        style: z.record(z.unknown()).describe("Style properties: color, fill, background, opacity, strokeStyle, strokeWidth"),
    }, async ({ id, style: s }) => {
        const result = styleElement(wss, id, s);
        if ("error" in result) {
            return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Styled "${id}"` }] };
    });
    server.tool("add_label", "Add a floating text label near an element. Optional metadata is stored as customData (invisible in UI, returned in get_canvas).", {
        text: z.string().describe("Label text"),
        near_id: z.string().describe("ID of the element to place the label near"),
        metadata: z.record(z.unknown()).optional().describe("Non-visual metadata stored as customData"),
    }, async ({ text, near_id, metadata }) => {
        const result = addLabel(wss, text, near_id, metadata);
        if (typeof result === "object" && "error" in result) {
            return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Added label "${text}" (${result})` }] };
    });
    server.tool("delete_element", "Delete an element and its bound text labels from the canvas.", {
        id: z.string().describe("Element ID to delete"),
    }, async ({ id }) => {
        const result = deleteElement(wss, id);
        if ("error" in result) {
            return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Deleted "${id}"` }] };
    });
    // --- Session tools ---
    server.tool("start_session", "Start a whiteboard session. The session_id (typically your chat JID) is included in all webhook trigger payloads, allowing the receiver to route responses back to the correct conversation. Optionally override the webhook URL and debounce interval for this session.", {
        session_id: z.string().describe("Session identifier — use your chat JID so webhooks route back to the right channel"),
        webhook_url: z.string().optional().describe("Per-session webhook URL override (falls back to NAPKIN_TRIGGER_WEBHOOK env var)"),
        debounce_ms: z.number().optional().describe("Override debounce interval in ms for this session (default: AGENT_TRIGGER_DEBOUNCE_MS, 3000 if unset). Use lower values for games/discrete interactions, higher for drawing/whiteboarding."),
        compact_triggers: z.boolean().optional().describe("When true, webhook payloads use changed_elements_compact instead of full changed_elements for this session (default: false)."),
    }, async ({ session_id, webhook_url, debounce_ms, compact_triggers }) => {
        sessions.startSession(session_id, webhook_url, debounce_ms, compact_triggers);
        wss.upsertSessionTrigger({
            sessionId: session_id,
            webhookUrl: webhook_url,
            debounceMs: debounce_ms,
            compactTriggers: compact_triggers,
        });
        const parts = [`Session "${session_id}" started.`];
        if (webhook_url)
            parts.push(`Webhook: ${webhook_url}`);
        if (debounce_ms !== undefined)
            parts.push(`Debounce: ${debounce_ms}ms`);
        if (compact_triggers !== undefined)
            parts.push(`Compact triggers: ${compact_triggers ? "on" : "off"}`);
        return {
            content: [{ type: "text", text: parts.join(" ") }],
        };
    });
    server.tool("end_session", "End a whiteboard session. Stops webhook delivery for this session.", {
        session_id: z.string().describe("Session identifier to end"),
    }, async ({ session_id }) => {
        const ended = sessions.endSession(session_id);
        wss.removeSessionTrigger(session_id);
        return {
            content: [
                {
                    type: "text",
                    text: ended
                        ? `Session "${session_id}" ended.`
                        : `Session "${session_id}" not found.`,
                },
            ],
        };
    });
    // --- Thought Bubble tools ---
    server.tool("add_thought_bubble", "Create a dashed purple thought bubble on the canvas. Optionally position near an existing node.", {
        content: z.string().describe("Text content of the thought bubble"),
        near_node_id: z.string().optional().describe("ID of a node to position the bubble near"),
    }, async ({ content, near_node_id }) => {
        const id = addThoughtBubble(wss, content, near_node_id);
        return {
            content: [
                {
                    type: "text",
                    text: `Created thought bubble ${id}${near_node_id ? ` near node "${near_node_id}"` : ""}.`,
                },
            ],
        };
    });
    server.tool("confirm_thought_bubble", "Convert a thought bubble to a permanent element — removes dashed style, emoji prefix, and sets full opacity.", {
        id: z.string().describe("ID of the thought bubble to confirm"),
    }, async ({ id }) => {
        const ok = confirmThoughtBubble(wss, id);
        if (!ok) {
            return {
                content: [{ type: "text", text: `Error: thought bubble "${id}" not found.` }],
                isError: true,
            };
        }
        return {
            content: [{ type: "text", text: `Confirmed thought bubble "${id}" — now a permanent element.` }],
        };
    });
    server.tool("dismiss_thought_bubble", "Remove a thought bubble from the canvas entirely.", {
        id: z.string().describe("ID of the thought bubble to dismiss"),
    }, async ({ id }) => {
        const ok = dismissThoughtBubble(wss, id);
        if (!ok) {
            return {
                content: [{ type: "text", text: `Error: thought bubble "${id}" not found.` }],
                isError: true,
            };
        }
        return {
            content: [{ type: "text", text: `Dismissed thought bubble "${id}".` }],
        };
    });
    server.tool("list_thought_bubbles", "List all current thought bubbles on the canvas.", {}, async () => {
        const bubbles = listThoughtBubbles(wss);
        return {
            content: [
                {
                    type: "text",
                    text: bubbles.length > 0
                        ? JSON.stringify(bubbles)
                        : "No thought bubbles on the canvas.",
                },
            ],
        };
    });
    // --- Visual Description tools (require ANTHROPIC_API_KEY) ---
    const hasVisionKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    if (hasVisionKey) {
        server.tool("describe_elements", "Describe one or more canvas elements using vision AI. Renders the elements to PNG server-side, sends to a vision model, and creates a grouped text annotation. Use for freehand sketches, ambiguous diagrams, pasted content, or any element where JSON structure is insufficient.", {
            element_ids: z.array(z.string()).describe("IDs of elements to describe together"),
            prompt: z.string().optional().describe("Custom prompt for the vision model (default: 'Describe what this represents in one sentence')"),
        }, async ({ element_ids, prompt }) => {
            const result = await describeElements(wss, element_ids, prompt);
            if ("error" in result) {
                return {
                    content: [{ type: "text", text: `Error: ${result.error}` }],
                    isError: true,
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Described: "${result.description}". Annotation added to canvas.`,
                    },
                ],
            };
        });
        server.tool("describe_sketch", "Convenience wrapper: describe a single freehand sketch element using vision AI.", {
            element_id: z.string().describe("ID of the freedraw element to describe"),
        }, async ({ element_id }) => {
            const result = await describeSketch(wss, element_id);
            if ("error" in result) {
                return {
                    content: [{ type: "text", text: `Error: ${result.error}` }],
                    isError: true,
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Sketch described: "${result.description}". Annotation added to canvas.`,
                    },
                ],
            };
        });
    } // end hasVisionKey
    // --- Layout tool ---
    server.tool("layout", "Auto-arrange all nodes and edges on the canvas using Dagre graph layout. Removes the need for manual coordinate placement. Call after adding nodes and connections.", {
        style: z.enum(["tree", "hierarchy", "LR", "TB"]).optional().describe("Layout direction: tree/LR = left-to-right, hierarchy/TB = top-to-bottom (default: TB)"),
    }, async ({ style }) => {
        const result = layoutCanvas(wss, style);
        if ("error" in result) {
            return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Layout applied to ${result.nodeCount} nodes.` }] };
    });
    // --- Animation tool ---
    server.tool("animate_element", "Animate an element's properties over time. Smoothly interpolates position, size, opacity, or color at ~30fps via WebSocket patches. The canvas remains interactive during animation. Use 'commit' to apply final properties atomically on completion (e.g. set isDeleted:true after a fade-out, or snap to exact position) — avoids a separate update_canvas call.", {
        id: z.string().describe("ID of the element to animate"),
        to: z.record(z.unknown()).describe("Target properties: x, y, width, height, opacity (number), strokeColor, backgroundColor (hex string)"),
        duration_ms: z.number().describe("Animation duration in milliseconds"),
        easing: z.enum(["linear", "ease-in", "ease-out"]).optional().describe("Easing function (default: linear)"),
        commit: z.record(z.unknown()).optional().describe("Properties to apply atomically on animation completion (e.g. { isDeleted: true } to remove after fade-out, or final position values)"),
    }, async ({ id, to, duration_ms, easing, commit }) => {
        const result = await animateElement(wss, id, to, duration_ms, easing, commit);
        if ("error" in result) {
            return {
                content: [{ type: "text", text: `Error: ${result.error}` }],
                isError: true,
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: `Animation complete: element "${id}" animated over ${duration_ms}ms.`,
                },
            ],
        };
    });
    // --- Export tool ---
    server.tool("export_canvas", "Export the current canvas to a file. Format is inferred from the file extension: .excalidraw (JSON, reopenable), .svg (vector), or .png (raster). The server renders SVG/PNG server-side — no browser needed.", {
        file_path: z.string().describe("Absolute path to write the file to. Extension determines format (.excalidraw, .svg, .png)"),
    }, async ({ file_path }) => {
        const result = await exportCanvas(wss, file_path);
        if ("error" in result) {
            return {
                content: [{ type: "text", text: `Error: ${result.error}` }],
                isError: true,
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: `Exported ${result.elementCount} elements to ${result.path}`,
                },
            ],
        };
    });
}
//# sourceMappingURL=tools.js.map