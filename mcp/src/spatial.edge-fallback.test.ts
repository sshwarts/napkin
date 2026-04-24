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

test("analyzeCanvas does not classify a node as a zone when an arrow label crosses it", (): void => {
  // Two nodes (from, to) with an arrow between them. The arrow has a text
  // label bound to it (containerId = arrow.id). The arrow label happens to
  // sit spatially inside a third rectangle (the "Dumb Broker" pattern).
  // That third rectangle should remain a node, not be classified as a zone.
  const fromNode = makeBaseElement("from", "rectangle", 100, 100, 160, 60);
  const fromLabel = makeBaseElement("from-text", "text", 120, 120, 120, 20);
  fromLabel.text = "AMP / DB";
  fromLabel.containerId = fromNode.id;
  fromNode.boundElements = [{ id: fromLabel.id, type: "text" }];
  const toNode = makeBaseElement("to", "rectangle", 100, 900, 160, 60);
  const toLabel = makeBaseElement("to-text", "text", 120, 920, 120, 20);
  toLabel.text = "Scott";
  toLabel.containerId = toNode.id;
  toNode.boundElements = [{ id: toLabel.id, type: "text" }];
  // A "Dumb Broker" node that sits between from and to along the arrow path.
  const broker = makeBaseElement("broker", "rectangle", 50, 400, 400, 200);
  const brokerLabel = makeBaseElement("broker-text", "text", 100, 450, 120, 20);
  brokerLabel.text = "Dumb Broker";
  brokerLabel.containerId = broker.id;
  broker.boundElements = [{ id: brokerLabel.id, type: "text" }];
  // Arrow from AMP/DB → Scott with a label "memories".
  const arrow = makeBaseElement("arrow", "arrow", 180, 161, 0, 758);
  arrow.points = [[0, 0], [0, 758]];
  arrow.startBinding = { elementId: fromNode.id, focus: 0, gap: 1 };
  arrow.endBinding = { elementId: toNode.id, focus: 0, gap: 1 };
  // The arrow label sits spatially inside the broker rectangle.
  const arrowLabel = makeBaseElement("arrow-label", "text", 150, 480, 100, 20);
  arrowLabel.text = "memories";
  arrowLabel.containerId = arrow.id;
  arrow.boundElements = [{ id: arrowLabel.id, type: "text" }];
  const result = analyzeCanvas([fromNode, fromLabel, toNode, toLabel, broker, brokerLabel, arrow, arrowLabel]);
  assert.ok(
    result.nodes.find((n) => n.id === broker.id),
    "broker should be classified as a node, not a zone"
  );
  assert.equal(
    result.zones.find((z) => z.id === broker.id),
    undefined,
    "broker should not appear in zones"
  );
});

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
