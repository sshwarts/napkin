import test from "node:test";
import assert from "node:assert/strict";
import type { ExcalidrawElement } from "./types.js";
import { estimateTextContainerHeight } from "./intent.js";
import { addThoughtBubble } from "./thought.js";

class TestCanvasWebSocketServer {
  private m_elements: ExcalidrawElement[];
  constructor(elements: ExcalidrawElement[] = []) {
    this.m_elements = elements;
  }
  getCanvasElements(): ExcalidrawElement[] {
    return this.m_elements;
  }
  updateCanvas(elements: ExcalidrawElement[]): void {
    this.m_elements = [...this.m_elements, ...elements];
  }
}

test("estimateTextContainerHeight keeps single-line nodes at minimum height", (): void => {
  const height = estimateTextContainerHeight("Auth Service", 180, 16, 1.25, 60, 24);
  assert.equal(height, 60);
});

test("estimateTextContainerHeight grows for wrapped multi-line content", (): void => {
  const height = estimateTextContainerHeight(
    "Auth Service has no redundancy and needs a replica plus circuit breaker for production safety.",
    230,
    16,
    1.25,
    60,
    24
  );
  assert.ok(height > 60);
});

test("addThoughtBubble uses wrap-aware container height", (): void => {
  const wss = new TestCanvasWebSocketServer();
  addThoughtBubble(
    wss as unknown as import("./websocket.js").CanvasWebSocketServer,
    "No auth replica in region A and region B\nSingle point of failure during traffic spikes"
  );
  const container = wss.getCanvasElements().find((el) => el.type === "rectangle");
  assert.ok(container, "thought bubble container should exist");
  assert.ok((container?.height ?? 0) > 60, "multiline thought bubble should exceed minimum height");
});
