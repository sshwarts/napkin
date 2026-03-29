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
import type { CanvasWebSocketServer } from "./websocket.js";
import type { SessionManager } from "./session.js";
/**
 * Start listening for agent triggers and delivering them via webhook.
 * Uses session context when available. No-op if no webhook is configured
 * and no session has a webhook URL.
 */
export declare function startWebhookDelivery(wss: CanvasWebSocketServer, sessions: SessionManager): void;
//# sourceMappingURL=webhook.d.ts.map