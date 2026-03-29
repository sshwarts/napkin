/**
 * @file Root component — mounts Excalidraw and manages WebSocket canvas sync.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, exportToSvg, exportToBlob } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { CanvasSync } from "./canvas-sync";

// Excalidraw API type.
interface ExcalidrawAPI {
  updateScene: (scene: { elements: unknown[]; appState?: Record<string, unknown> }) => void;
  getSceneElements: () => unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
  scrollToContent: () => void;
  refresh: () => void;
}

/**
 * Apply a server update to the Excalidraw scene.
 */
function applyUpdate(api: ExcalidrawAPI, elements: unknown[], mode: "patch" | "replace"): void {
  if (mode === "replace") {
    api.updateScene({ elements });
    api.scrollToContent();
  } else {
    const wasPreviouslyEmpty = api.getSceneElements().length === 0;
    const current = api.getSceneElements() as Array<{ id: string }>;
    const currentById = new Map(current.map((el) => [el.id, el]));
    for (const el of elements as Array<{ id: string }>) {
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
      />
    </div>
  );
}

export default App;
