/**
 * @file Root component — mounts Excalidraw and manages WebSocket canvas sync.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, exportToSvg, exportToBlob, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, PointBinding } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import { CanvasSync } from "./canvas-sync";

// Excalidraw API type.
interface ExcalidrawAPI {
  updateScene: (scene: { elements: unknown[]; appState?: Record<string, unknown> }) => void;
  getSceneElements: () => ExcalidrawElement[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
  scrollToContent: () => void;
  refresh: () => void;
}

/** Arrow binding fields preserved across restoreElements. */
type ArrowEl = ExcalidrawElement & {
  startBinding: PointBinding | null;
  endBinding: PointBinding | null;
};

/** Text element fields used for center-anchored dimension refresh. */
type TextEl = ExcalidrawElement & {
  containerId: string | null;
};

/**
 * Run restoreElements on incoming elements to get correct font metrics.
 *
 * repairBindings must be true (refreshDimensions is gated behind it), so we
 * save and restore arrow bindings that get incorrectly nullified when the
 * binding target isn't in the incoming set.  For standalone text, we preserve
 * the server-intended center point since the corrected dimensions shift x/y.
 */
function restoreIncoming(incoming: ExcalidrawElement[]): ExcalidrawElement[] {
  // 1. Capture server-intended center for standalone text.
  const centerById = new Map<string, { cx: number; cy: number }>();
  for (const el of incoming) {
    if (el.type === "text" && !(el as TextEl).containerId) {
      centerById.set(el.id, { cx: el.x + el.width / 2, cy: el.y + el.height / 2 });
    }
  }
  // 2. Capture arrow bindings before restore clobbers them.
  const bindingsById = new Map<string, { start: PointBinding | null; end: PointBinding | null }>();
  for (const el of incoming) {
    if (el.type === "arrow") {
      const arrow = el as ArrowEl;
      bindingsById.set(el.id, { start: arrow.startBinding, end: arrow.endBinding });
    }
  }
  // 3. Restore with repairBindings (required to enable refreshDimensions).
  const restored = restoreElements(incoming, null, {
    repairBindings: true,
    refreshDimensions: true,
  }) as ExcalidrawElement[];
  // 4. Patch back arrow bindings and re-anchor standalone text.
  return restored.map((el) => {
    const bindings = bindingsById.get(el.id);
    if (bindings) {
      const arrow = el as ArrowEl;
      return { ...el, startBinding: bindings.start ?? arrow.startBinding, endBinding: bindings.end ?? arrow.endBinding };
    }
    const center = centerById.get(el.id);
    if (center) {
      return { ...el, x: center.cx - el.width / 2, y: center.cy - el.height / 2 };
    }
    return el;
  });
}

/**
 * Apply a server update to the Excalidraw scene.
 */
function applyUpdate(api: ExcalidrawAPI, elements: unknown[], mode: "patch" | "replace"): void {
  const incoming = restoreIncoming(elements as ExcalidrawElement[]);
  if (mode === "replace") {
    api.updateScene({ elements: incoming });
    api.scrollToContent();
  } else {
    const wasPreviouslyEmpty = api.getSceneElements().length === 0;
    const current = api.getSceneElements();
    const currentById = new Map(current.map((el) => [el.id, el]));
    for (const el of incoming) {
      currentById.set(el.id, el);
    }
    api.updateScene({
      elements: Array.from(currentById.values()),
    });
    if (wasPreviouslyEmpty && elements.length > 0) {
      api.scrollToContent();
    }
  }
}

function App(): React.JSX.Element {
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const canvasSyncRef = useRef<CanvasSync | null>(null);
  const pendingRef = useRef<{ elements: unknown[]; mode: "patch" | "replace" } | null>(null);
  const [connectionStatus, setConnectionStatus] = useState(false);
  const [triggerPulse, setTriggerPulse] = useState(false);

  const handleServerUpdate = useCallback(
    (elements: unknown[], mode: "patch" | "replace") => {
      const api = apiRef.current;
      if (!api) {
        pendingRef.current = { elements, mode };
        return;
      }
      canvasSyncRef.current?.suppressChanges();
      applyUpdate(api, elements, mode);
    },
    []
  );

  // Handle export requests from the server.
  const handleExportRequest = useCallback(
    async (requestId: string, format: "svg" | "png") => {
      const api = apiRef.current;
      const sync = canvasSyncRef.current;
      if (!api || !sync) return;
      try {
        const elements = api.getSceneElements() as never[];
        const appState = api.getAppState() as never;
        const files = api.getFiles() as never;
        if (format === "svg") {
          const svgEl = await exportToSvg({ elements, appState, files });
          sync.sendExportResponse(requestId, "svg", svgEl.outerHTML);
        } else {
          const blob = await exportToBlob({ elements, appState, files, mimeType: "image/png" });
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = (reader.result as string).split(",")[1];
            sync.sendExportResponse(requestId, "png", base64);
          };
          reader.readAsDataURL(blob);
        }
      } catch (err) {
        console.error("[napkin] Export failed:", err);
      }
    },
    []
  );

  // Pulse the status dot when a trigger fires.
  const handleTriggerFired = useCallback((_source: string) => {
    setTriggerPulse(true);
    setTimeout(() => setTriggerPulse(false), 1500);
  }, []);

  useEffect(() => {
    const sync = new CanvasSync(handleServerUpdate, handleExportRequest, handleTriggerFired);
    canvasSyncRef.current = sync;
    sync.connect();
    return () => {
      sync.disconnect();
      canvasSyncRef.current = null;
    };
  }, [handleServerUpdate, handleExportRequest, handleTriggerFired]);

  useEffect(() => {
    const interval = setInterval(() => {
      const connected = canvasSyncRef.current?.getIsConnected() ?? false;
      setConnectionStatus((prev) => (prev !== connected ? connected : prev));
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const handleChange = useCallback(
    (elements: readonly unknown[]) => {
      canvasSyncRef.current?.sendCanvasUpdate(elements);
    },
    []
  );

  const handleAPI = useCallback((api: unknown) => {
    apiRef.current = api as ExcalidrawAPI;
    if (pendingRef.current) {
      const { elements, mode } = pendingRef.current;
      pendingRef.current = null;
      canvasSyncRef.current?.suppressChanges();
      applyUpdate(api as ExcalidrawAPI, elements, mode);
    }
  }, []);

  return (
    <div style={{ width: "100%", height: "100vh", position: "relative" }}>
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          background: "rgba(255,255,255,0.9)",
          borderRadius: 6,
          fontSize: 12,
          fontFamily: "system-ui, sans-serif",
          boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: triggerPulse ? "#f59e0b" : connectionStatus ? "#22c55e" : "#ef4444",
            transition: "background 0.3s",
            boxShadow: triggerPulse ? "0 0 6px 2px rgba(245,158,11,0.5)" : "none",
          }}
        />
        {triggerPulse ? "Agent notified" : connectionStatus ? "MCP connected" : "MCP disconnected"}
      </div>
      <Excalidraw
        excalidrawAPI={handleAPI}
        onChange={handleChange}
        initialData={{
          appState: { zoom: { value: 1.01 as unknown as never } },
        }}
      />
    </div>
  );
}

export default App;
