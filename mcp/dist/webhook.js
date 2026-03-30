/**
 * @file Webhook trigger delivery for Napkin.
 *
 * Delivers trigger events via HTTP POST. Uses session context when
 * available: per-session webhook URL override and session_id in payload.
 * Falls back to NAPKIN_TRIGGER_WEBHOOK env var for sessionless triggers.
 *
 * Retry: up to 2 retries with exponential backoff (1s, 2s).
 * If all retries fail, logs and moves on.
 */
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { analyzeCanvas } from "./spatial.js";
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
/**
 * Build compact changed element summaries for webhook payloads.
 */
function buildCompactChangedElements(changedIds, allElements) {
    const elementById = new Map();
    for (const el of allElements) {
        const id = el.id;
        if (typeof id === "string") {
            elementById.set(id, el);
        }
    }
    const compact = [];
    for (const id of changedIds) {
        const el = elementById.get(id);
        if (!el)
            continue;
        let label;
        if (typeof el.text === "string" && el.text.length > 0) {
            label = el.text;
        }
        else if (Array.isArray(el.boundElements)) {
            for (const bound of el.boundElements) {
                if (typeof bound !== "object" || bound === null)
                    continue;
                const boundRecord = bound;
                if (boundRecord.type !== "text")
                    continue;
                const textId = boundRecord.id;
                if (typeof textId !== "string")
                    continue;
                const textEl = elementById.get(textId);
                if (textEl && typeof textEl.text === "string" && textEl.text.length > 0) {
                    label = textEl.text;
                    break;
                }
            }
        }
        const metadata = typeof el.customData === "object" && el.customData !== null
            ? el.customData
            : undefined;
        const status = metadata && typeof metadata.status === "string"
            ? metadata.status
            : undefined;
        const compactEl = {
            id,
            type: typeof el.type === "string" ? el.type : "unknown",
        };
        if (label !== undefined)
            compactEl.label = label;
        if (typeof el.startBinding === "object" && el.startBinding !== null) {
            const start = el.startBinding.elementId;
            if (typeof start === "string")
                compactEl.from = start;
        }
        if (typeof el.endBinding === "object" && el.endBinding !== null) {
            const end = el.endBinding.elementId;
            if (typeof end === "string")
                compactEl.to = end;
        }
        if (status !== undefined)
            compactEl.status = status;
        if (metadata !== undefined)
            compactEl.metadata = metadata;
        compact.push(compactEl);
    }
    return compact;
}
/**
 * POST a JSON payload to a URL. Returns true on 2xx, false otherwise.
 */
function postJson(url, body) {
    return new Promise((resolve) => {
        const isHttps = url.protocol === "https:";
        const makeRequest = isHttps ? https.request : http.request;
        const req = makeRequest({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
            },
            timeout: 5000,
        }, (res) => {
            res.resume();
            resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
            req.destroy();
            resolve(false);
        });
        req.end(body);
    });
}
/**
 * POST with retry and exponential backoff.
 */
async function postWithRetry(url, body) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
            await new Promise((r) => setTimeout(r, delay));
        }
        const ok = await postJson(url, body);
        if (ok)
            return true;
    }
    return false;
}
/**
 * Start listening for agent triggers and delivering them via webhook.
 * Delivery is session-scoped: triggers already include session and routing context.
 */
export function startWebhookDelivery(wss) {
    if (process.env.NAPKIN_WEBHOOK_DISABLED === "true") {
        console.error("[napkin] Webhook delivery disabled (NAPKIN_WEBHOOK_DISABLED=true)");
        return;
    }
    const globalUrl = process.env.NAPKIN_TRIGGER_WEBHOOK;
    if (globalUrl) {
        console.error(`[napkin] Webhook delivery active → ${globalUrl}`);
    }
    const includeCanvas = process.env.NAPKIN_TRIGGER_INCLUDE_CANVAS === "true";
    const defaultCompactTriggers = process.env.NAPKIN_COMPACT_TRIGGERS === "true";
    wss.on("agent_trigger", async (trigger) => {
        let url = null;
        if (trigger.webhook_url) {
            try {
                url = new URL(trigger.webhook_url);
            }
            catch {
                url = null;
            }
        }
        else if (globalUrl) {
            try {
                url = new URL(globalUrl);
            }
            catch {
                url = null;
            }
        }
        if (!url)
            return; // No webhook configured and no session webhook.
        const compactTriggers = trigger.compact_triggers ?? defaultCompactTriggers;
        const message = trigger.message
            ?? `[napkin] Canvas ${trigger.source === "debounce" ? "updated (idle)" : "event"}`;
        const payload = {
            trigger_id: randomUUID(),
            source: trigger.source,
            timestamp: trigger.timestamp,
            message,
        };
        if (trigger.session_id)
            payload.session_id = trigger.session_id;
        if (trigger.changed_element_ids && trigger.changed_element_ids.length > 0) {
            payload.changed_element_ids = trigger.changed_element_ids;
            const allElements = wss.getCanvasElements();
            if (compactTriggers) {
                payload.changed_elements_compact = buildCompactChangedElements(trigger.changed_element_ids, allElements);
            }
            else {
                // Embed full element data so the agent skips the get_canvas_diff round-trip.
                const changedSet = new Set(trigger.changed_element_ids);
                payload.changed_elements = allElements.filter((el) => changedSet.has(el.id));
            }
        }
        if (trigger.change_summary) {
            payload.change_summary = trigger.change_summary;
        }
        if (trigger.change_type) {
            payload.change_type = trigger.change_type;
        }
        if (includeCanvas) {
            const elements = wss.getCanvasElements();
            if (elements.length > 0) {
                payload.canvas = analyzeCanvas(elements);
            }
        }
        const body = JSON.stringify(payload);
        const ok = await postWithRetry(url, body);
        if (!ok) {
            console.error(`[napkin] Webhook delivery failed after ${MAX_RETRIES + 1} attempts: ${url.href}`);
        }
    });
}
//# sourceMappingURL=webhook.js.map