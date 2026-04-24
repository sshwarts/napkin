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

let nodeCounter = 0;
function makeNode(
  id: string,
  customData?: Record<string, unknown>,
  width = 160,
  height = 60
): ExcalidrawElement[] {
  // Give each node a unique position so analyzeCanvas doesn't detect
  // one rectangle as a "zone" containing the others.
  const baseX = (nodeCounter++) * (width + 50);
  const textId = `${id}-text`;
  const node: ExcalidrawElement = {
    id,
    type: "rectangle",
    x: baseX,
    y: 0,
    width,
    height,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    strokeStyle: "solid",
    opacity: 100,
    roughness: 0,
    groupIds: [],
    boundElements: [{ id: textId, type: "text" }],
    startBinding: null,
    endBinding: null,
    ...(customData ? { customData } : {}),
  };
  const text: ExcalidrawElement = {
    id: textId,
    type: "text",
    x: baseX + 10,
    y: 10,
    width: width - 20,
    height: 20,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    strokeStyle: "solid",
    opacity: 100,
    roughness: 0,
    groupIds: [],
    boundElements: null,
    startBinding: null,
    endBinding: null,
    text: id,
    originalText: id,
    containerId: id,
  };
  return [node, text];
}

function patchY(patches: Array<Record<string, unknown>>, id: string): number {
  const p = patches.find((patch) => patch.id === id);
  assert.ok(p, `expected patch for ${id}`);
  return p.y as number;
}

function patchX(patches: Array<Record<string, unknown>>, id: string): number {
  const p = patches.find((patch) => patch.id === id);
  assert.ok(p, `expected patch for ${id}`);
  return p.x as number;
}

test("zoned nodes on same row share Y in TB layout", (): void => {
  const wss = new TestCanvasWebSocketServer([
    ...makeNode("a", { zone: "services", row: 1 }),
    ...makeNode("b", { zone: "services", row: 1 }),
    ...makeNode("c", { zone: "services", row: 1 }),
  ]);
  layoutCanvas(wss as unknown as import("./websocket.js").CanvasWebSocketServer, "TB");
  const ya = patchY(wss.lastPatches, "a");
  const yb = patchY(wss.lastPatches, "b");
  const yc = patchY(wss.lastPatches, "c");
  assert.equal(ya, yb, "a and b should share Y");
  assert.equal(yb, yc, "b and c should share Y");
});

test("zoned nodes on same row share X in LR layout", (): void => {
  const wss = new TestCanvasWebSocketServer([
    ...makeNode("a", { zone: "services", row: 1 }),
    ...makeNode("b", { zone: "services", row: 1 }),
  ]);
  layoutCanvas(wss as unknown as import("./websocket.js").CanvasWebSocketServer, "LR");
  const xa = patchX(wss.lastPatches, "a");
  const xb = patchX(wss.lastPatches, "b");
  assert.equal(xa, xb, "a and b should share X in LR");
});

test("different rows produce different Y bands (TB)", (): void => {
  const wss = new TestCanvasWebSocketServer([
    ...makeNode("r0", { zone: "triggers", row: 0 }),
    ...makeNode("r1", { zone: "services", row: 1 }),
    ...makeNode("r2", { zone: "data", row: 2 }),
  ]);
  layoutCanvas(wss as unknown as import("./websocket.js").CanvasWebSocketServer, "TB");
  const y0 = patchY(wss.lastPatches, "r0");
  const y1 = patchY(wss.lastPatches, "r1");
  const y2 = patchY(wss.lastPatches, "r2");
  assert.ok(y0 < y1, `row 0 (${y0}) should be above row 1 (${y1})`);
  assert.ok(y1 < y2, `row 1 (${y1}) should be above row 2 (${y2})`);
  assert.equal(y1 - y0, y2 - y1, "adjacent rows should be evenly spaced");
});

test("sparse rows produce proportional spacing (TB)", (): void => {
  const wss = new TestCanvasWebSocketServer([
    ...makeNode("r0", { zone: "triggers", row: 0 }),
    ...makeNode("r2", { zone: "data", row: 2 }),
  ]);
  layoutCanvas(wss as unknown as import("./websocket.js").CanvasWebSocketServer, "TB");
  const y0 = patchY(wss.lastPatches, "r0");
  const y2 = patchY(wss.lastPatches, "r2");
  // Gap between row 0 and row 2 is 2 bands — at least 2x (ranksep + height).
  assert.ok(y2 - y0 >= 2 * (120 + 60), `row 2 should be 2 bands below row 0 (got ${y2 - y0})`);
});

test("different zones on same row share Y (TB)", (): void => {
  const wss = new TestCanvasWebSocketServer([
    ...makeNode("svc", { zone: "services", row: 1 }),
    ...makeNode("shared", { zone: "data", row: 1 }),
  ]);
  layoutCanvas(wss as unknown as import("./websocket.js").CanvasWebSocketServer, "TB");
  assert.equal(patchY(wss.lastPatches, "svc"), patchY(wss.lastPatches, "shared"));
});

test("unzoned nodes are not snapped to zone rows", (): void => {
  const wss5 = new TestCanvasWebSocketServer([
    ...makeNode("zoned5", { zone: "services", row: 5 }),
    ...makeNode("unzoned5"),
  ]);
  layoutCanvas(wss5 as unknown as import("./websocket.js").CanvasWebSocketServer, "TB");
  const yZoned = patchY(wss5.lastPatches, "zoned5");
  const yUnzoned = patchY(wss5.lastPatches, "unzoned5");
  assert.notEqual(yZoned, yUnzoned, "row=5 zoned node should not share Y with unzoned sibling");
  assert.ok(yZoned > yUnzoned, `zoned at row=5 (${yZoned}) should be far below unzoned at Dagre's rank 0 (${yUnzoned})`);
});

test("row without zone is ignored (both required)", (): void => {
  const wss = new TestCanvasWebSocketServer([
    ...makeNode("a", { row: 3 }),
    ...makeNode("b"),
  ]);
  layoutCanvas(wss as unknown as import("./websocket.js").CanvasWebSocketServer, "TB");
  const ya = patchY(wss.lastPatches, "a");
  const yb = patchY(wss.lastPatches, "b");
  assert.equal(ya, yb, "row without zone should not force a snap");
});
