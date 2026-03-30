/**
 * @file Shared types for the Napkin MCP server.
 */

/**
 * Minimal representation of an Excalidraw element.
 * Full type comes from @excalidraw/excalidraw but we only need
 * the shape that flows over the wire.
 */
export interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: string;
  backgroundColor: string;
  strokeStyle: string;
  opacity: number;
  roughness: number;
  groupIds: string[];
  boundElements: BoundElement[] | null;
  startBinding: Binding | null;
  endBinding: Binding | null;
  /** Text content for text elements. */
  text?: string;
  /** Original text before line wrapping. */
  originalText?: string;
  /** For text elements: ID of the container element, or null if floating. */
  containerId?: string | null;
  /** Whether the element is soft-deleted. */
  isDeleted?: boolean;
  [key: string]: unknown;
}

export interface BoundElement {
  id: string;
  type: string;
}

export interface Binding {
  elementId: string;
  focus: number;
  gap: number;
}

/**
 * Minimal Excalidraw app state — we only cache what we receive.
 */
export interface AppState {
  [key: string]: unknown;
}

// --- WebSocket protocol messages ---

export interface CanvasUpdate {
  type: "canvas_update";
  elements: ExcalidrawElement[];
  appState?: AppState;
}

export interface CanvasPatch {
  type: "canvas_patch";
  elements: ExcalidrawElement[];
}

export interface CanvasReplace {
  type: "canvas_replace";
  elements: ExcalidrawElement[];
}

export interface ChatMessage {
  type: "chat_message";
  message: string;
}

export interface ExportRequest {
  type: "export_request";
  requestId: string;
  format: "svg" | "png";
}

export interface ExportResponse {
  type: "export_response";
  requestId: string;
  data: string; // base64 for PNG, raw SVG string for SVG
  format: "svg" | "png";
}

export interface TriggerFired {
  type: "trigger_fired";
  source: "debounce" | "chat" | "reconnect";
}

export type WsMessage = CanvasUpdate | CanvasPatch | CanvasReplace | ChatMessage | ExportRequest | ExportResponse | TriggerFired;

// --- Agent trigger types ---

export interface AgentTrigger {
  session_id?: string;
  source: "debounce" | "chat" | "reconnect";
  message?: string;
  timestamp: number;
  webhook_url?: string;
  compact_triggers?: boolean;
  changed_element_ids?: string[];
  change_summary?: string;
  change_type?: "semantic" | "cosmetic";
}

// --- Spatial analysis output types ---

export interface StructuredCanvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  zones: CanvasZone[];
  sticky_notes: StickyNote[];
  thought_bubbles: ThoughtBubble[];
  freehand_sketches: FreehandSketch[];
}

export interface CanvasNode {
  id: string;
  label: string;
  type: "box" | "ellipse" | "diamond";
  zone?: string;
  properties: NodeProperty[];
  status?: "deprecated" | "active" | "parking_lot";
  thought_bubble: boolean;
  metadata?: Record<string, unknown>;
}

export interface NodeProperty {
  text: string;
  confidence: number;
  inferred: boolean;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  metadata?: Record<string, unknown>;
  label?: string;
  thought_bubble: boolean;
}

export interface CanvasZone {
  id: string;
  label: string;
  is_parking_lot: boolean;
  contained_element_ids: string[];
}

export interface StickyNote {
  id: string;
  text: string;
  status?: "parking_lot";
  zone?: string;
}

export interface ThoughtBubble {
  id: string;
  content: string;
  position: "near" | "attached";
  related_node?: string;
}

export interface FreehandSketch {
  id: string;
  description?: string;
  related_node?: string;
}
