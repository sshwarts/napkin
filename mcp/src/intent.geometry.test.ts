import test from "node:test";
import assert from "node:assert/strict";
import { resolveConnectionRouting, resolveArrowGeometry } from "./intent.js";
type RoutingCase = {
  name: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  expectedSourceSide: "top" | "bottom" | "left" | "right";
};
const TEST_CASES: RoutingCase[] = [
  {
    name: "Inventory to Database prefers bottom in TB flow despite large horizontal spread",
    from: { x: 1110, y: 100 },
    to: { x: 55, y: 590 },
    expectedSourceSide: "bottom",
  },
  {
    name: "Client to Gateway exits bottom for vertical down link",
    from: { x: 55, y: 50 },
    to: { x: 55, y: 230 },
    expectedSourceSide: "bottom",
  },
  {
    name: "Gateway to Auth exits right for mostly horizontal right link",
    from: { x: 55, y: 230 },
    to: { x: 600, y: 100 },
    expectedSourceSide: "right",
  },
  {
    name: "Auth to Gateway exits left for mostly horizontal left link",
    from: { x: 600, y: 100 },
    to: { x: 55, y: 230 },
    expectedSourceSide: "left",
  },
];
test("resolveConnectionRouting chooses expected source edge", (): void => {
  for (const testCase of TEST_CASES) {
    const routing = resolveConnectionRouting(testCase.from.x, testCase.from.y, testCase.to.x, testCase.to.y);
    assert.equal(routing.sourceSide, testCase.expectedSourceSide, testCase.name);
  }
});

test("connect-before-layout recompute uses post-layout geometry", (): void => {
  const nodeSize = { width: 160, height: 60 };
  const preLayoutGeometry = resolveArrowGeometry(
    { x: 50, y: 50, width: nodeSize.width, height: nodeSize.height },
    { x: 50, y: 230, width: nodeSize.width, height: nodeSize.height }
  );
  const postLayoutGeometry = resolveArrowGeometry(
    { x: 1110, y: 100, width: nodeSize.width, height: nodeSize.height },
    { x: 55, y: 590, width: nodeSize.width, height: nodeSize.height }
  );
  assert.notDeepEqual(postLayoutGeometry, preLayoutGeometry, "geometry must update after layout repositions nodes");
  assert.equal(postLayoutGeometry.startX, 1190, "post-layout source x should anchor on source center for vertical route");
  assert.equal(postLayoutGeometry.startY, 161, "post-layout source should exit bottom edge");
  assert.equal(postLayoutGeometry.endX, 135, "post-layout target x should anchor on target center for vertical route");
  assert.equal(postLayoutGeometry.endY, 589, "post-layout target should enter top edge");
});
