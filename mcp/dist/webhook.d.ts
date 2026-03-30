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
/**
 * Start listening for agent triggers and delivering them via webhook.
 * Delivery is session-scoped: triggers already include session and routing context.
 */
export declare function startWebhookDelivery(wss: CanvasWebSocketServer): void;
//# sourceMappingURL=webhook.d.ts.map