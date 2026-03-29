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
export declare class CanvasWebSocketServer extends EventEmitter {
    private m_wss;
    private m_clients;
    private m_state;
    private m_port;
    private m_debounceTimer;
    private m_debounceMs;
    private m_pendingTriggers;
    private m_changedSinceTrigger;
    /** Snapshot of element states before changes, for computing change_summary. */
    private m_preChangeSnapshot;
    /** Element IDs recently written via MCP — echoes of these are suppressed. */
    private m_agentWrittenIds;
    /** Pending browser export callbacks keyed by requestId. */
    private m_pendingExports;
    /** Counter for auto-generating fractional indices. */
    private m_indexCounter;
    private static readonly ECHO_SUPPRESS_MS;
    /** Timestamp of last server-initiated canvas_replace (reconnect hydration). */
    private m_lastReplaceSentAt;
    private static readonly HYDRATION_SUPPRESS_MS;
    constructor(port?: number);
    /**
     * Override the debounce interval at runtime (e.g. per-session).
     */
    setDebounceMs(ms: number): void;
    /**
     * Start the WebSocket server.
     */
    start(): void;
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
    clearCanvas(): void;
    /**
     * Apply partial patches to existing cached elements. Each patch must have
     * an `id` matching a cached element. Unknown fields are merged in; the
     * rest of the element is preserved. Returns IDs of elements not found.
     */
    patchCanvas(patches: Array<Record<string, unknown>>): string[];
    /**
     * Merge element updates into the cache and broadcast a patch to all
     * connected browsers. Agent-initiated — does NOT restart the debounce timer.
     */
    updateCanvas(elements: ExcalidrawElement[]): void;
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
    private resetDebounce;
    private cancelDebounce;
    private drainChangedIds;
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
}
//# sourceMappingURL=websocket.d.ts.map