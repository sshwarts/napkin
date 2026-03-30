import test from "node:test";
import assert from "node:assert/strict";
import type { ExcalidrawElement } from "./types.js";
import { analyzeCanvas } from "./spatial.js";

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

test("analyzeCanvas extracts edge from customData when arrow bindings are null", (): void => {
  const fromNode = makeBaseElement("node-from", "rectangle", 100, 100, 160, 60);
  const toNode = makeBaseElement("node-to", "rectangle", 100, 300, 160, 60);
  const fromLabel = makeBaseElement("text-from", "text", 120, 120, 120, 20);
  fromLabel.text = "Inventory Service";
  fromLabel.originalText = "Inventory Service";
  fromLabel.containerId = fromNode.id;
  const toLabel = makeBaseElement("text-to", "text", 120, 320, 120, 20);
  toLabel.text = "Database";
  toLabel.originalText = "Database";
  toLabel.containerId = toNode.id;
  fromNode.boundElements = [{ id: fromLabel.id, type: "text" }, { id: "edge-1", type: "arrow" }];
  toNode.boundElements = [{ id: toLabel.id, type: "text" }, { id: "edge-1", type: "arrow" }];
  const arrow = makeBaseElement("edge-1", "arrow", 180, 161, 0, 428);
  arrow.points = [[0, 0], [0, 428]];
  arrow.endArrowhead = "arrow";
  arrow.startBinding = null;
  arrow.endBinding = null;
  arrow.customData = { from: fromNode.id, to: toNode.id };
  const result = analyzeCanvas([fromNode, toNode, fromLabel, toLabel, arrow]);
  const edge = result.edges.find((e) => e.id === "edge-1");
  assert.ok(edge, "edge should be present");
  assert.equal(edge?.from, fromNode.id);
  assert.equal(edge?.to, toNode.id);
});
