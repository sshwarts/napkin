/**
 * @file WebSocket server and canvas state cache for Napkin.
 *
 * Browser connects via WebSocket, sends canvas state on every change.
 * MCP tools read/write the cached state. Updates broadcast to all
 * connected browsers.
 *
 * Agent trigger model: debounce canvas changes, fire trigger when
 * canvas is quiet or when a chat message arrives.
 */
import { EventEmitter } from "node:events";
import type { ExcalidrawElement, AgentTrigger } from "./types.js";
import type { Session } from "./session.js";
export declare class CanvasWebSocketServer extends EventEmitter {
    private m_wss;
    private m_clients;
    private m_state;
    private m_port;
    private m_defaultDebounceMs;
    private m_pendingTriggers;
    private m_sessionTriggers;
    /** Element IDs recently written via MCP, with optional originating session. */
    private m_agentWrittenIds;
    /** Pending browser export callbacks keyed by requestId. */
    private m_pendingExports;
    /** Counter for auto-generating fractional indices. */
    private m_indexCounter;
    /** Batch broadcast nesting depth. */
    private m_batchBroadcastDepth;
    /** Pending element patch entries during a deferred batch. */
    private m_pendingBatchPatchById;
    /** Whether clear_canvas occurred during the current deferred batch. */
    private m_pendingBatchReplace;
    private static readonly ECHO_SUPPRESS_MS;
    /** Timestamp of last server-initiated canvas_replace (reconnect hydration). */
    private m_lastReplaceSentAt;
    private static readonly HYDRATION_SUPPRESS_MS;
    constructor(port?: number);
    upsertSessionTrigger(session: {
        sessionId: string;
        webhookUrl?: string;
        debounceMs?: number;
        compactTriggers?: boolean;
    }): void;
    removeSessionTrigger(sessionId: string): void;
    restoreSessionTriggers(sessions: Session[]): void;
    /**
     * Start the WebSocket server.
     */
    start(): void;
    /**
     * Begin deferred broadcast mode. Element writes still update server state
     * immediately, but browser patches are coalesced until flush/end.
     */
    beginBatchBroadcast(): void;
    /**
     * Flush pending deferred writes to the browser while keeping deferred mode active.
     * Useful as an animation barrier in apply_intents.
     */
    flushBatchBroadcast(): void;
    /**
     * End deferred broadcast mode. When the outermost batch ends, pending writes
     * are emitted as a coalesced patch/replace.
     */
    endBatchBroadcast(): void;
    /**
     * Return true when deferred broadcast mode is active.
     */
    isBatchBroadcasting(): boolean;
    /**
     * Return the current cached canvas elements as JSON string.
     */
    getCanvasRaw(): string;
    /**
     * Return the current cached canvas elements.
     */
    getCanvasElements(): ExcalidrawElement[];
    /**
     * Clear all elements from the cache and broadcast an empty canvas to browsers.
     */
    clearCanvas(originSessionId?: string): void;
    /**
     * Apply partial patches to existing cached elements. Each patch must have
     * an `id` matching a cached element. Unknown fields are merged in; the
     * rest of the element is preserved. Returns IDs of elements not found.
     */
    patchCanvas(patches: Array<Record<string, unknown>>, originSessionId?: string): string[];
    /**
     * Merge element updates into the cache and broadcast a patch to all
     * connected browsers. Agent-initiated — does NOT restart the debounce timer.
     */
    updateCanvas(elements: ExcalidrawElement[], originSessionId?: string): void;
    /**
     * Return the number of connected browser clients.
     */
    getClientCount(): number;
    /**
     * Request the browser to export the canvas as SVG or PNG.
     * Returns the exported data (SVG string or PNG base64).
     * Requires a connected browser.
     */
    requestExport(format: "svg" | "png"): Promise<{
        data: string;
        format: string;
    } | {
        error: string;
    }>;
    /**
     * Return and drain all pending agent triggers.
     */
    drainTriggers(): AgentTrigger[];
    /**
     * Return elements that have been updated since the given timestamp.
     */
    getCanvasDiff(sinceTimestamp: number): ExcalidrawElement[];
    /**
     * Stop the WebSocket server and disconnect all clients.
     */
    stop(): void;
    private handleConnection;
    private handleMessage;
    private resetDebounceForSession;
    private emitDebounceTriggerForSession;
    private cancelDebounceForSession;
    private drainChangedIdsForSession;
    /**
     * Classify changes as semantic or cosmetic.
     * Semantic: new/deleted element, text changed, connection changed, type changed.
     * Cosmetic: small position change (<20px), color/style change, opacity change.
     */
    private classifyChanges;
    /** Get element label from its bound text or text content. */
    private getLabel;
    /** Compute a human-readable summary of what changed. */
    private computeChangeSummary;
    private emitTrigger;
    /**
     * Apply type-aware default values for missing fields.
     * Explicit fields always win — only undefined fields are filled.
     */
    private applyDefaults;
    private broadcast;
    /**
     * Broadcast immediately or enqueue patch entries for deferred batch flush.
     */
    private broadcastOrQueuePatch;
    /**
     * Flush deferred batch writes as a single replace or patch message.
     */
    private flushPendingBatchMessages;
}
//# sourceMappingURL=websocket.d.ts.map