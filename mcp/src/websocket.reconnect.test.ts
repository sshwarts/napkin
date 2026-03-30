import test from "node:test";
import assert from "node:assert/strict";
import type { ExcalidrawElement } from "./types.js";
import { CanvasWebSocketServer } from "./websocket.js";

function makeElement(id: string): ExcalidrawElement {
  return {
    id,
    type: "rectangle",
    x: 100,
    y: 100,
    width: 160,
    height: 60,
    strokeColor: "#1e1e1e",
    backgroundColor: "#a5d8ff",
    strokeStyle: "solid",
    opacity: 100,
    roughness: 0,
    groupIds: [],
    boundElements: null,
    startBinding: null,
    endBinding: null,
  };
}

test("reconnect hydration does not wipe non-empty server cache with empty browser update", (): void => {
  const wss = new CanvasWebSocketServer();
  const serverElement = makeElement("server-node-1");
  wss.updateCanvas([serverElement]);
  (wss as unknown as { m_lastReplaceSentAt: number }).m_lastReplaceSentAt = Date.now();
  const hydrationUpdate = Buffer.from(JSON.stringify({
    type: "canvas_update",
    elements: [],
  }));
  (wss as unknown as { handleMessage: (ws: unknown, data: Buffer) => void }).handleMessage(null, hydrationUpdate);
  const elementsAfter = wss.getCanvasElements();
  assert.equal(elementsAfter.length, 1, "server cache should remain intact");
  assert.equal(elementsAfter[0].id, serverElement.id);
});
