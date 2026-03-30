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
import { WebSocketServer, WebSocket } from "ws";
import type {
  ExcalidrawElement,
  AppState,
  WsMessage,
  CanvasPatch,
  CanvasReplace,
  CanvasUpdate,
  ChatMessage,
  ExportRequest,
  ExportResponse,
  TriggerFired,
  AgentTrigger,
} from "./types.js";
import type { Session } from "./session.js";

const DEFAULT_WS_PORT = 3002;
const DEFAULT_DEBOUNCE_MS = 3000;

/** In-memory canvas state cache. */
interface CanvasState {
  elements: ExcalidrawElement[];
  appState: AppState | null;
  lastUpdated: number;
}

interface SessionTriggerState {
  sessionId: string;
  webhookUrl?: string;
  debounceMs: number;
  compactTriggers: boolean;
  debounceTimer: NodeJS.Timeout | null;
  changedSinceTrigger: Set<string>;
  preChangeSnapshot: Map<string, ExcalidrawElement>;
}

export class CanvasWebSocketServer extends EventEmitter {
  private m_wss: WebSocketServer | null = null;
  private m_clients: Set<WebSocket> = new Set();
  private m_state: CanvasState = {
    elements: [],
    appState: null,
    lastUpdated: 0,
  };
  private m_port: number;
  private m_defaultDebounceMs: number;
  private m_pendingTriggers: AgentTrigger[] = [];
  private m_sessionTriggers: Map<string, SessionTriggerState> = new Map();
  /** Element IDs recently written via MCP — echoes of these are suppressed. */
  private m_agentWrittenIds: Map<string, number> = new Map();
  /** Pending browser export callbacks keyed by requestId. */
  private m_pendingExports: Map<string, (data: string) => void> = new Map();
  /** Counter for auto-generating fractional indices. */
  private m_indexCounter: number = Date.now() % 100000;
  private static readonly ECHO_SUPPRESS_MS = 2000;
  /** Timestamp of last server-initiated canvas_replace (reconnect hydration). */
  private m_lastReplaceSentAt: number = 0;
  private static readonly HYDRATION_SUPPRESS_MS = 2000;

  constructor(port?: number) {
    super();
    this.m_port = port ?? parseInt(process.env.MCP_WS_PORT ?? String(DEFAULT_WS_PORT), 10);
    this.m_defaultDebounceMs = parseInt(
      process.env.AGENT_TRIGGER_DEBOUNCE_MS ?? String(DEFAULT_DEBOUNCE_MS),
      10
    );
  }

  upsertSessionTrigger(session: {
    sessionId: string;
    webhookUrl?: string;
    debounceMs?: number;
    compactTriggers?: boolean;
  }): void {
    const existing = this.m_sessionTriggers.get(session.sessionId);
    if (existing) {
      existing.webhookUrl = session.webhookUrl;
      existing.debounceMs = session.debounceMs ?? this.m_defaultDebounceMs;
      existing.compactTriggers = session.compactTriggers ?? false;
      return;
    }
    this.m_sessionTriggers.set(session.sessionId, {
      sessionId: session.sessionId,
      webhookUrl: session.webhookUrl,
      debounceMs: session.debounceMs ?? this.m_defaultDebounceMs,
      compactTriggers: session.compactTriggers ?? false,
      debounceTimer: null,
      changedSinceTrigger: new Set<string>(),
      preChangeSnapshot: new Map<string, ExcalidrawElement>(),
    });
  }

  removeSessionTrigger(sessionId: string): void {
    const state = this.m_sessionTriggers.get(sessionId);
    if (state?.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    this.m_sessionTriggers.delete(sessionId);
  }

  restoreSessionTriggers(sessions: Session[]): void {
    this.m_sessionTriggers.clear();
    for (const session of sessions) {
      this.upsertSessionTrigger({
        sessionId: session.sessionId,
        webhookUrl: session.webhookUrl,
        debounceMs: session.debounceMs,
        compactTriggers: session.compactTriggers,
      });
    }
  }

  /**
   * Start the WebSocket server.
   */
  start(): void {
    this.m_wss = new WebSocketServer({ port: this.m_port });
    this.m_wss.on("connection", (ws: WebSocket) => {
      this.m_clients.add(ws);
      this.handleConnection(ws);
    });
    console.error(`[napkin] WebSocket server listening on port ${this.m_port}`);
  }

  /**
   * Return the current cached canvas elements as JSON string.
   */
  getCanvasRaw(): string {
    return JSON.stringify(this.m_state.elements);
  }

  /**
   * Return the current cached canvas elements.
   */
  getCanvasElements(): ExcalidrawElement[] {
    return this.m_state.elements;
  }

  /**
   * Clear all elements from the cache and broadcast an empty canvas to browsers.
   */
  clearCanvas(): void {
    this.m_state.elements = [];
    this.m_state.appState = null;
    this.m_state.lastUpdated = Date.now();
    const replace: CanvasReplace = { type: "canvas_replace", elements: [] };
    this.broadcast(replace);
  }

  /**
   * Apply partial patches to existing cached elements. Each patch must have
   * an `id` matching a cached element. Unknown fields are merged in; the
   * rest of the element is preserved. Returns IDs of elements not found.
   */
  patchCanvas(patches: Array<Record<string, unknown>>): string[] {
    const notFound: string[] = [];
    const patched: ExcalidrawElement[] = [];
    const now = Date.now();
    for (const patch of patches) {
      const id = patch.id as string;
      if (!id) continue;
      const idx = this.m_state.elements.findIndex((el) => el.id === id);
      if (idx === -1) {
        notFound.push(id);
        continue;
      }
      const updated: ExcalidrawElement = {
        ...this.m_state.elements[idx],
        ...patch,
        version: ((this.m_state.elements[idx].version as number) ?? 1) + 1,
        updated: now,
      } as ExcalidrawElement;
      this.m_state.elements[idx] = updated;
      patched.push(updated);
      this.m_agentWrittenIds.set(id, now);
    }
    if (patched.length > 0) {
      this.m_state.lastUpdated = now;
      const patchMsg: CanvasPatch = { type: "canvas_patch", elements: patched };
      this.broadcast(patchMsg);
    }
    return notFound;
  }

  /**
   * Merge element updates into the cache and broadcast a patch to all
   * connected browsers. Agent-initiated — does NOT restart the debounce timer.
   */
  updateCanvas(elements: ExcalidrawElement[]): void {
    const existingById = new Map<string, number>();
    for (let i = 0; i < this.m_state.elements.length; i++) {
      existingById.set(this.m_state.elements[i].id, i);
    }
    const merged = [...this.m_state.elements];
    const now = Date.now();
    for (const el of elements) {
      this.applyDefaults(el);
      const idx = existingById.get(el.id);
      if (idx !== undefined) {
        merged[idx] = el;
      } else {
        merged.push(el);
      }
      // Mark as agent-written so browser echoes are suppressed.
      this.m_agentWrittenIds.set(el.id, now);
    }
    this.m_state.elements = merged;
    this.m_state.lastUpdated = Date.now();
    const patch: CanvasPatch = { type: "canvas_patch", elements };
    this.broadcast(patch);
  }

  /**
   * Return the number of connected browser clients.
   */
  getClientCount(): number {
    return this.m_clients.size;
  }

  /**
   * Request the browser to export the canvas as SVG or PNG.
   * Returns the exported data (SVG string or PNG base64).
   * Requires a connected browser.
   */
  requestExport(format: "svg" | "png"): Promise<{ data: string; format: string } | { error: string }> {
    return new Promise((resolve) => {
      if (this.m_clients.size === 0) {
        resolve({ error: "No browser connected — cannot export SVG/PNG. Use .excalidraw format for server-side export." });
        return;
      }
      const requestId = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const timeout = setTimeout(() => {
        this.m_pendingExports.delete(requestId);
        resolve({ error: "Browser export timed out after 10s." });
      }, 10000);
      this.m_pendingExports.set(requestId, (data: string) => {
        clearTimeout(timeout);
        this.m_pendingExports.delete(requestId);
        resolve({ data, format });
      });
      const req: ExportRequest = { type: "export_request", requestId, format };
      // Send to first connected client.
      for (const client of this.m_clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(req));
          break;
        }
      }
    });
  }

  /**
   * Return and drain all pending agent triggers.
   */
  drainTriggers(): AgentTrigger[] {
    const triggers = this.m_pendingTriggers;
    this.m_pendingTriggers = [];
    return triggers;
  }

  /**
   * Return elements that have been updated since the given timestamp.
   */
  getCanvasDiff(sinceTimestamp: number): ExcalidrawElement[] {
    return this.m_state.elements.filter(
      (el) => (el.updated as number ?? 0) > sinceTimestamp
    );
  }

  /**
   * Stop the WebSocket server and disconnect all clients.
   */
  stop(): void {
    for (const session of this.m_sessionTriggers.values()) {
      if (session.debounceTimer) {
        clearTimeout(session.debounceTimer);
        session.debounceTimer = null;
      }
    }
    for (const client of this.m_clients) {
      client.close();
    }
    this.m_clients.clear();
    this.m_wss?.close();
    this.m_wss = null;
  }

  // --- private ---

  private handleConnection(ws: WebSocket): void {
    console.error(`[napkin] Browser connected (${this.m_clients.size} total)`);
    if (this.m_state.elements.length > 0) {
      const replace: CanvasReplace = {
        type: "canvas_replace",
        elements: this.m_state.elements,
      };
      ws.send(JSON.stringify(replace));
      this.m_lastReplaceSentAt = Date.now();
    }
    // Notify agents that a browser (re)connected — they may need to re-establish sessions.
    for (const session of this.m_sessionTriggers.values()) {
      this.emitTrigger({
        session_id: session.sessionId,
        source: "reconnect",
        timestamp: Date.now(),
        message: "[napkin] Browser connected",
        webhook_url: session.webhookUrl,
        compact_triggers: session.compactTriggers,
      });
    }
    ws.on("message", (data: Buffer) => {
      this.handleMessage(ws, data);
    });
    ws.on("close", () => {
      this.m_clients.delete(ws);
      console.error(`[napkin] Browser disconnected (${this.m_clients.size} remaining)`);
    });
    ws.on("error", (err: Error) => {
      console.error(`[napkin] WebSocket error: ${err.message}`);
      this.m_clients.delete(ws);
    });
  }

  private handleMessage(_ws: WebSocket, data: Buffer): void {
    let msg: WsMessage;
    try {
      msg = JSON.parse(data.toString()) as WsMessage;
    } catch {
      console.error("[napkin] Invalid JSON from browser, ignoring");
      return;
    }
    if (msg.type === "canvas_update") {
      const update = msg as CanvasUpdate;
      const now = Date.now();
      // Suppress reconnect hydration echo — the browser is just echoing
      // back the canvas_replace we sent on connect.
      if (this.m_lastReplaceSentAt > 0 &&
          (now - this.m_lastReplaceSentAt) < CanvasWebSocketServer.HYDRATION_SUPPRESS_MS) {
        this.m_state.elements = update.elements;
        this.m_state.appState = update.appState ?? null;
        this.m_state.lastUpdated = now;
        return; // Update cache but don't trigger.
      }
      const previousElements = this.m_state.elements;
      // Diff: find elements that changed (new, updated, or deleted).
      // Suppress echoes of elements the agent recently wrote via MCP.
      const oldById = new Map(previousElements.map((el) => [el.id, el.updated as number ?? 0]));
      const changedIds = new Set<string>();
      for (const el of update.elements) {
        const oldUpdated = oldById.get(el.id);
        if (oldUpdated === undefined || (el.updated as number ?? 0) !== oldUpdated) {
          // Check if this is an echo of an agent write.
          const agentWriteTime = this.m_agentWrittenIds.get(el.id);
          if (agentWriteTime && (now - agentWriteTime) < CanvasWebSocketServer.ECHO_SUPPRESS_MS) {
            continue; // Suppress — this is the browser echoing back our own write.
          }
          changedIds.add(el.id);
        }
      }
      // Clean up expired agent write markers.
      for (const [id, writeTime] of this.m_agentWrittenIds) {
        if (now - writeTime >= CanvasWebSocketServer.ECHO_SUPPRESS_MS) {
          this.m_agentWrittenIds.delete(id);
        }
      }
      // Also detect deleted elements (present in old, missing in new).
      const newIdSet = new Set(update.elements.map((el) => el.id));
      for (const oldEl of previousElements) {
        if (!newIdSet.has(oldEl.id)) {
          changedIds.add(oldEl.id);
        }
      }
      this.m_state.elements = update.elements;
      this.m_state.appState = update.appState ?? null;
      this.m_state.lastUpdated = Date.now();
      // Only restart debounce if something actually changed.
      // Prevents browser echo of agent patches from triggering false wakeups.
      if (changedIds.size > 0) {
        for (const session of this.m_sessionTriggers.values()) {
          for (const changedId of changedIds) {
            session.changedSinceTrigger.add(changedId);
            if (!session.preChangeSnapshot.has(changedId)) {
              const oldEl = previousElements.find((el) => el.id === changedId);
              if (oldEl) {
                session.preChangeSnapshot.set(changedId, { ...oldEl });
              }
            }
          }
          this.resetDebounceForSession(session);
        }
      }
    } else if (msg.type === "chat_message") {
      const chat = msg as ChatMessage;
      for (const session of this.m_sessionTriggers.values()) {
        this.cancelDebounceForSession(session);
        const changedIds = this.drainChangedIdsForSession(session);
        this.emitTrigger({
          session_id: session.sessionId,
          source: "chat",
          message: chat.message,
          timestamp: Date.now(),
          webhook_url: session.webhookUrl,
          compact_triggers: session.compactTriggers,
          changed_element_ids: changedIds,
          change_summary: this.computeChangeSummary(changedIds, session.preChangeSnapshot),
          change_type: this.classifyChanges(changedIds, session.preChangeSnapshot),
        });
      }
    } else if (msg.type === "export_response") {
      const resp = msg as ExportResponse;
      const callback = this.m_pendingExports.get(resp.requestId);
      if (callback) {
        callback(resp.data);
      }
    }
  }

  private resetDebounceForSession(session: SessionTriggerState): void {
    this.cancelDebounceForSession(session);
    if (session.debounceMs === 0) {
      this.emitDebounceTriggerForSession(session);
      return;
    }
    session.debounceTimer = setTimeout(() => {
      session.debounceTimer = null;
      this.emitDebounceTriggerForSession(session);
    }, session.debounceMs);
  }

  private emitDebounceTriggerForSession(session: SessionTriggerState): void {
    const changedIds = this.drainChangedIdsForSession(session);
    const changeType = this.classifyChanges(changedIds, session.preChangeSnapshot);
    // Optionally suppress cosmetic-only triggers.
    if (changeType === "cosmetic" && process.env.NAPKIN_TRIGGER_SEMANTIC_ONLY === "true") {
      session.preChangeSnapshot.clear();
      return;
    }
    this.emitTrigger({
      session_id: session.sessionId,
      source: "debounce",
      timestamp: Date.now(),
      webhook_url: session.webhookUrl,
      compact_triggers: session.compactTriggers,
      changed_element_ids: changedIds,
      change_summary: this.computeChangeSummary(changedIds, session.preChangeSnapshot),
      change_type: changeType,
    });
  }

  private cancelDebounceForSession(session: SessionTriggerState): void {
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = null;
    }
  }

  private drainChangedIdsForSession(session: SessionTriggerState): string[] {
    const ids = Array.from(session.changedSinceTrigger);
    session.changedSinceTrigger.clear();
    return ids;
  }

  /**
   * Classify changes as semantic or cosmetic.
   * Semantic: new/deleted element, text changed, connection changed, type changed.
   * Cosmetic: small position change (<20px), color/style change, opacity change.
   */
  private classifyChanges(changedIds: string[], preChangeSnapshot: Map<string, ExcalidrawElement>): "semantic" | "cosmetic" {
    const MOVE_THRESHOLD = 20;
    const newById = new Map(this.m_state.elements.map((el) => [el.id, el]));
    for (const id of changedIds) {
      const newEl = newById.get(id);
      const oldEl = preChangeSnapshot.get(id);
      // New or deleted element = semantic.
      if (!oldEl || !newEl) return "semantic";
      if (oldEl.isDeleted !== newEl.isDeleted) return "semantic";
      // Text changed = semantic.
      if (oldEl.text !== newEl.text) return "semantic";
      // Type changed = semantic.
      if (oldEl.type !== newEl.type) return "semantic";
      // Bindings changed = semantic.
      const oldBindings = JSON.stringify(oldEl.startBinding) + JSON.stringify(oldEl.endBinding);
      const newBindings = JSON.stringify(newEl.startBinding) + JSON.stringify(newEl.endBinding);
      if (oldBindings !== newBindings) return "semantic";
      // Large move = semantic.
      const dx = Math.abs(newEl.x - oldEl.x);
      const dy = Math.abs(newEl.y - oldEl.y);
      if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) return "semantic";
      // Size changed significantly = semantic.
      if (Math.abs(newEl.width - oldEl.width) > MOVE_THRESHOLD) return "semantic";
      if (Math.abs(newEl.height - oldEl.height) > MOVE_THRESHOLD) return "semantic";
    }
    return "cosmetic";
  }

  /** Get element label from its bound text or text content. */
  private getLabel(el: ExcalidrawElement): string {
    if (el.text) return `"${el.text}"`;
    if (el.boundElements) {
      for (const bound of el.boundElements) {
        if (bound.type === "text") {
          const textEl = this.m_state.elements.find((e) => e.id === bound.id);
          if (textEl?.text) return `"${textEl.text}"`;
        }
      }
    }
    return `${el.type}:${el.id.slice(0, 6)}`;
  }

  /** Compute a human-readable summary of what changed. */
  private computeChangeSummary(changedIds: string[], preChangeSnapshot: Map<string, ExcalidrawElement>): string {
    if (changedIds.length === 0) return "";
    const parts: string[] = [];
    const newById = new Map(this.m_state.elements.map((el) => [el.id, el]));
    // Skip bound text elements — they move with their parent container.
    const boundTextIds = new Set<string>();
    for (const el of this.m_state.elements) {
      if (el.boundElements) {
        for (const b of el.boundElements) {
          if (b.type === "text") boundTextIds.add(b.id);
        }
      }
    }
    for (const id of changedIds) {
      if (boundTextIds.has(id)) continue;
      const newEl = newById.get(id);
      const oldEl = preChangeSnapshot.get(id);
      if (!newEl && !oldEl) continue;
      if (!oldEl && newEl) {
        // New element.
        parts.push(`added ${newEl.type} ${this.getLabel(newEl)}`);
      } else if (oldEl && newEl) {
        // Modified element.
        const label = this.getLabel(newEl);
        const changes: string[] = [];
        if (oldEl.x !== newEl.x || oldEl.y !== newEl.y) {
          const dx = Math.round(newEl.x - oldEl.x);
          const dy = Math.round(newEl.y - oldEl.y);
          changes.push(`moved (${dx > 0 ? "+" : ""}${dx}, ${dy > 0 ? "+" : ""}${dy})`);
        }
        if (oldEl.width !== newEl.width || oldEl.height !== newEl.height) {
          changes.push(`resized to ${Math.round(newEl.width)}x${Math.round(newEl.height)}`);
        }
        if (oldEl.text !== newEl.text && newEl.text) {
          changes.push(`text → "${newEl.text}"`);
        }
        if (oldEl.strokeColor !== newEl.strokeColor) {
          changes.push(`color → ${newEl.strokeColor}`);
        }
        if (oldEl.backgroundColor !== newEl.backgroundColor) {
          changes.push(`fill → ${newEl.backgroundColor}`);
        }
        if (oldEl.isDeleted !== newEl.isDeleted && newEl.isDeleted) {
          changes.push("deleted");
        }
        if (changes.length > 0) {
          parts.push(`${label}: ${changes.join(", ")}`);
        } else {
          parts.push(`${label}: updated`);
        }
      }
    }
    preChangeSnapshot.clear();
    if (parts.length === 0) return "";
    return parts.join("; ");
  }

  private emitTrigger(trigger: AgentTrigger): void {
    this.m_pendingTriggers.push(trigger);
    this.emit("agent_trigger", trigger);
    // Notify browser so the status dot can pulse.
    const notification: TriggerFired = { type: "trigger_fired", source: trigger.source };
    this.broadcast(notification);
  }

  /**
   * Apply type-aware default values for missing fields.
   * Explicit fields always win — only undefined fields are filled.
   */
  private applyDefaults(el: ExcalidrawElement): void {
    const r = el as Record<string, unknown>;
    // Auto-generate ID if missing.
    if (!r.id) {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      let id = "";
      for (let i = 0; i < 20; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
      r.id = id;
    }
    // Generate index if missing.
    if (!r.index) {
      this.m_indexCounter++;
      r.index = `a${this.m_indexCounter.toString(36)}`;
    }
    // Type-specific dimension defaults.
    if (r.width === undefined) {
      if (el.type === "text") {
        // Estimate width from text content. Average char width ≈ 0.55× fontSize.
        const fontSize = (r.fontSize as number) ?? 16;
        const text = (r.text as string) ?? "";
        const lines = text.split("\n");
        const maxLineLen = Math.max(...lines.map((l: string) => l.length));
        r.width = Math.max(10, Math.ceil(maxLineLen * fontSize * 0.55));
      } else {
        r.width = 160;
      }
    }
    if (r.height === undefined) {
      if (el.type === "text") {
        const fontSize = (r.fontSize as number) ?? 16;
        const lineHeight = (r.lineHeight as number) ?? 1.25;
        const text = (r.text as string) ?? "";
        const lineCount = Math.max(1, text.split("\n").length);
        r.height = fontSize * lineHeight * lineCount;
      } else if (el.type === "diamond") {
        r.height = 100;
      } else {
        r.height = 60;
      }
    }
    // Type-specific roundness defaults.
    if (r.roundness === undefined) {
      if (el.type === "rectangle" || el.type === "diamond" || el.type === "ellipse") {
        r.roundness = { type: 3 };
      } else if (el.type === "arrow" || el.type === "line") {
        r.roundness = { type: 2 };
      } else {
        r.roundness = null;
      }
    }
    // Common defaults — apply to all element types.
    const common: Record<string, unknown> = {
      angle: 0,
      seed: Math.floor(Math.random() * 100000),
      version: 1,
      versionNonce: Math.floor(Math.random() * 1000000),
      isDeleted: false,
      groupIds: [],
      frameId: null,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
      roughness: 0,
      opacity: 100,
      strokeWidth: 2,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeStyle: "solid",
      startBinding: null,
      endBinding: null,
    };
    for (const [key, val] of Object.entries(common)) {
      if (r[key] === undefined) r[key] = val;
    }
    // Text-specific defaults.
    // Text-specific: only fill originalText and containerId if missing.
    // Do NOT touch fontFamily, width, height, autoResize — let the agent's values pass through.
    if (el.type === "text") {
      if (r.originalText === undefined) r.originalText = r.text ?? "";
      if (r.containerId === undefined) r.containerId = null;
      if (r.lineHeight === undefined) r.lineHeight = 1.25;
      if (r.autoResize === undefined) r.autoResize = true;
      if (r.fontSize === undefined) r.fontSize = 16;
      if (r.fontFamily === undefined) r.fontFamily = parseInt(process.env.NAPKIN_DEFAULT_FONT_FAMILY ?? "5", 10);
      if (r.textAlign === undefined) r.textAlign = "left";
      if (r.verticalAlign === undefined) r.verticalAlign = "top";
    }
    // Arrow/line defaults.
    if (el.type === "arrow" || el.type === "line") {
      if (r.points === undefined) r.points = [[0, 0], [100, 0]];
      if (r.lastCommittedPoint === undefined) r.lastCommittedPoint = null;
      if (el.type === "arrow") {
        if (r.startArrowhead === undefined) r.startArrowhead = null;
        if (r.endArrowhead === undefined) r.endArrowhead = "arrow";
        if (r.elbowed === undefined) r.elbowed = false;
      }
    }
    // Freedraw defaults.
    if (el.type === "freedraw") {
      if (r.points === undefined) r.points = [];
      if (r.pressures === undefined) r.pressures = [];
      if (r.simulatePressure === undefined) r.simulatePressure = true;
      if (r.lastCommittedPoint === undefined) r.lastCommittedPoint = null;
    }
  }

  private broadcast(msg: WsMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.m_clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}
