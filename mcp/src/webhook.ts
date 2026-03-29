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
import type { CanvasWebSocketServer } from "./websocket.js";
import type { AgentTrigger } from "./types.js";
import type { SessionManager } from "./session.js";
import { analyzeCanvas } from "./spatial.js";

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

interface WebhookPayload {
  trigger_id: string;
  session_id?: string;
  source: "debounce" | "chat" | "reconnect";
  timestamp: number;
  /** Always present — required by nanoclaw webhook channel and OpenClaw. */
  message: string;
  changed_element_ids?: string[];
  /** Full element data for changed elements — avoids a get_canvas_diff round-trip. */
  changed_elements?: unknown[];
  /** Human-readable description of what changed. */
  change_summary?: string;
  /** Classification: semantic (new/deleted/text/connection) or cosmetic (nudge/style). */
  change_type?: "semantic" | "cosmetic";
  canvas?: unknown;
}

/**
 * POST a JSON payload to a URL. Returns true on 2xx, false otherwise.
 */
function postJson(url: URL, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    const isHttps = url.protocol === "https:";
    const makeRequest = isHttps ? https.request : http.request;
    const req = makeRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
      }
    );
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
async function postWithRetry(url: URL, body: string): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
    const ok = await postJson(url, body);
    if (ok) return true;
  }
  return false;
}

/**
 * Resolve the webhook URL to use: session override > global env var.
 */
function resolveWebhookUrl(sessions: SessionManager): URL | null {
  // Check for an active session with a per-session webhook.
  const session = sessions.getActiveSession();
  if (session?.webhookUrl) {
    try {
      return new URL(session.webhookUrl);
    } catch {
      // Fall through to global.
    }
  }
  // Fall back to global env var.
  const globalUrl = process.env.NAPKIN_TRIGGER_WEBHOOK;
  if (!globalUrl) return null;
  try {
    return new URL(globalUrl);
  } catch {
    return null;
  }
}

/**
 * Start listening for agent triggers and delivering them via webhook.
 * Uses session context when available. No-op if no webhook is configured
 * and no session has a webhook URL.
 */
export function startWebhookDelivery(
  wss: CanvasWebSocketServer,
  sessions: SessionManager
): void {
  if (process.env.NAPKIN_WEBHOOK_DISABLED === "true") {
    console.error("[napkin] Webhook delivery disabled (NAPKIN_WEBHOOK_DISABLED=true)");
    return;
  }
  const globalUrl = process.env.NAPKIN_TRIGGER_WEBHOOK;
  if (globalUrl) {
    console.error(`[napkin] Webhook delivery active → ${globalUrl}`);
  }
  const includeCanvas = process.env.NAPKIN_TRIGGER_INCLUDE_CANVAS === "true";
  wss.on("agent_trigger", async (trigger: AgentTrigger) => {
    const url = resolveWebhookUrl(sessions);
    if (!url) return; // No webhook configured and no session webhook.
    const session = sessions.getActiveSession();
    const message = trigger.message
      ?? `[napkin] Canvas ${trigger.source === "debounce" ? "updated (idle)" : "event"}`;
    const payload: WebhookPayload = {
      trigger_id: randomUUID(),
      source: trigger.source,
      timestamp: trigger.timestamp,
      message,
    };
    if (session) {
      payload.session_id = session.sessionId;
    }
    if (trigger.changed_element_ids && trigger.changed_element_ids.length > 0) {
      payload.changed_element_ids = trigger.changed_element_ids;
      // Embed full element data so the agent skips the get_canvas_diff round-trip.
      const allElements = wss.getCanvasElements();
      const changedSet = new Set(trigger.changed_element_ids);
      payload.changed_elements = allElements.filter((el) => changedSet.has(el.id));
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
