import test from "node:test";
import assert from "node:assert/strict";
import type { ExcalidrawElement } from "./types.js";
import { layoutCanvas } from "./layout.js";

class TestCanvasWebSocketServer {
  private readonly m_elements: ExcalidrawElement[];
  public lastPatches: Array<Record<string, unknown>> = [];
  constructor(elements: ExcalidrawElement[]) {
    this.m_elements = elements;
  }
  getCanvasElements(): ExcalidrawElement[] {
    return this.m_elements;
  }
  patchCanvas(patches: Array<Record<string, unknown>>): string[] {
    this.lastPatches = patches;
    return [];
  }
}

function makeBaseElement(id: string, type: string, x: number, y: number, width: number, height: number): ExcalidrawElement {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    strokeStyle: "solid",
    opacity: 100,
    roughness: 0,
    groupIds: [],
    boundElements: null,
    startBinding: null,
    endBinding: null,
  };
}

test("layout recomputes arrow geometry when bindings are null but customData has from/to", (): void => {
  const fromNode = makeBaseElement("node-inventory", "rectangle", 1110, 100, 200, 60);
  const toNode = makeBaseElement("node-db", "rectangle", 55, 590, 160, 60);
  const fromText = makeBaseElement("text-inventory", "text", 1140, 120, 140, 20);
  fromText.text = "Inventory Service";
  fromText.originalText = "Inventory Service";
  fromText.containerId = fromNode.id;
  const toText = makeBaseElement("text-db", "text", 85, 610, 100, 20);
  toText.text = "Database";
  toText.originalText = "Database";
  toText.containerId = toNode.id;
  const arrow = makeBaseElement("edge-inventory-db", "arrow", 1311, 131, 1176, 458);
  arrow.points = [[0, 0], [-1176, 458]];
  arrow.startBinding = null;
  arrow.endBinding = null;
  arrow.customData = { from: fromNode.id, to: toNode.id };
  fromNode.boundElements = [{ id: fromText.id, type: "text" }, { id: arrow.id, type: "arrow" }];
  toNode.boundElements = [{ id: toText.id, type: "text" }, { id: arrow.id, type: "arrow" }];
  const wss = new TestCanvasWebSocketServer([fromNode, toNode, fromText, toText, arrow]);
  const result = layoutCanvas(wss as unknown as import("./websocket.js").CanvasWebSocketServer, "TB");
  assert.deepEqual(result, { ok: true, nodeCount: 2 });
  const arrowPatch = wss.lastPatches.find((patch) => patch.id === arrow.id);
  assert.ok(arrowPatch, "layout should patch arrow when from/to is in customData");
  assert.equal(arrowPatch?.startBinding, null);
  assert.equal(arrowPatch?.endBinding, null);
});
