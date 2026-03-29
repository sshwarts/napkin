/**
 * @file WebSocket client for bidirectional canvas sync with the MCP server.
 *
 * Handles connection, reconnection, and the change-loop guard that prevents
 * infinite update cycles between Excalidraw onChange and server patches.
 */

/** Message types matching the MCP server WebSocket protocol. */
interface CanvasUpdateMsg {
  type: "canvas_update";
  elements: unknown[];
  appState?: unknown;
}

interface CanvasPatchMsg {
  type: "canvas_patch";
  elements: unknown[];
}

interface CanvasReplaceMsg {
  type: "canvas_replace";
  elements: unknown[];
}

interface ExportRequestMsg {
  type: "export_request";
  requestId: string;
  format: "svg" | "png";
}

interface TriggerFiredMsg {
  type: "trigger_fired";
  source: string;
}

type ServerMessage = CanvasPatchMsg | CanvasReplaceMsg | ExportRequestMsg | TriggerFiredMsg;

/** Callback the App provides to receive server-initiated canvas changes. */
export type OnServerUpdate = (elements: unknown[], mode: "patch" | "replace") => void;

/** Callback for export requests from the server. */
export type OnExportRequest = (requestId: string, format: "svg" | "png") => void;

/** Callback when a trigger fires (for UI feedback). */
export type OnTriggerFired = (source: string) => void;

const DEFAULT_WS_URL = "ws://localhost:3002";
const RECONNECT_INTERVAL_MS = 2000;

export class CanvasSync {
  private m_ws: WebSocket | null = null;
  private m_url: string;
  private m_onServerUpdate: OnServerUpdate;
  private m_onExportRequest: OnExportRequest | null = null;
  private m_onTriggerFired: OnTriggerFired | null = null;
  private m_reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private m_isConnected: boolean = false;
  /** Count of pending server-initiated scene updates to suppress. */
  private m_suppressCount: number = 0;

  constructor(
    onServerUpdate: OnServerUpdate,
    onExportRequest?: OnExportRequest,
    onTriggerFired?: OnTriggerFired
  ) {
    this.m_url = import.meta.env.VITE_MCP_WS_URL ?? DEFAULT_WS_URL;
    this.m_onServerUpdate = onServerUpdate;
    this.m_onExportRequest = onExportRequest ?? null;
    this.m_onTriggerFired = onTriggerFired ?? null;
  }

  /**
   * Open the WebSocket connection. Automatically reconnects on close.
   */
  connect(): void {
    this.cleanup();
    this.m_ws = new WebSocket(this.m_url);
    this.m_ws.onopen = () => {
      this.m_isConnected = true;
      console.log("[napkin] WebSocket connected to", this.m_url);
    };
    this.m_ws.onmessage = (event: MessageEvent) => {
      this.handleServerMessage(event.data as string);
    };
    this.m_ws.onclose = () => {
      this.m_isConnected = false;
      console.log("[napkin] WebSocket disconnected, reconnecting...");
      this.scheduleReconnect();
    };
    this.m_ws.onerror = (err: Event) => {
      console.error("[napkin] WebSocket error:", err);
    };
  }

  /**
   * Disconnect and stop reconnection attempts.
   */
  disconnect(): void {
    this.cleanup();
  }

  /**
   * Called by the Excalidraw onChange handler. Sends canvas state to server
   * unless the change was triggered by a server update (loop guard).
   */
  sendCanvasUpdate(elements: readonly unknown[]): void {
    if (this.m_suppressCount > 0) {
      this.m_suppressCount--;
      return;
    }
    if (!this.m_isConnected || !this.m_ws) {
      return;
    }
    const msg: CanvasUpdateMsg = {
      type: "canvas_update",
      elements: elements as unknown[],
    };
    this.m_ws.send(JSON.stringify(msg));
  }

  /**
   * Send an export response back to the server.
   */
  sendExportResponse(requestId: string, format: "svg" | "png", data: string): void {
    if (!this.m_isConnected || !this.m_ws) return;
    this.m_ws.send(JSON.stringify({
      type: "export_response",
      requestId,
      format,
      data,
    }));
  }

  /**
   * Suppress the next N onChange calls.
   */
  suppressChanges(count: number = 1): void {
    this.m_suppressCount += count;
  }

  getIsConnected(): boolean {
    return this.m_isConnected;
  }

  // --- private ---

  private handleServerMessage(data: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      console.error("[napkin] Invalid JSON from server");
      return;
    }
    if (msg.type === "canvas_patch") {
      console.log("[napkin] canvas_patch received:", msg.elements?.length, "elements");
      this.m_onServerUpdate(msg.elements, "patch");
    } else if (msg.type === "canvas_replace") {
      console.log("[napkin] canvas_replace received:", msg.elements?.length, "elements");
      this.m_onServerUpdate(msg.elements, "replace");
    } else if (msg.type === "export_request") {
      this.m_onExportRequest?.(msg.requestId, msg.format);
    } else if (msg.type === "trigger_fired") {
      this.m_onTriggerFired?.(msg.source);
    }
  }

  private scheduleReconnect(): void {
    if (this.m_reconnectTimer) return;
    this.m_reconnectTimer = setTimeout(() => {
      this.m_reconnectTimer = null;
      this.connect();
    }, RECONNECT_INTERVAL_MS);
  }

  private cleanup(): void {
    if (this.m_reconnectTimer) {
      clearTimeout(this.m_reconnectTimer);
      this.m_reconnectTimer = null;
    }
    if (this.m_ws) {
      this.m_ws.onclose = null; // prevent reconnect on intentional close
      this.m_ws.close();
      this.m_ws = null;
    }
    this.m_isConnected = false;
  }
}
