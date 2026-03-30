/**
 * @file Spatial analysis layer for Napkin.
 *
 * Parses raw Excalidraw element JSON into a StructuredCanvas that agents
 * can reason about — nodes, edges, zones, proximity associations, thought
 * bubbles, and freehand sketches. No coordinates exposed; only semantic
 * structure.
 */
const GRID_CELL_SIZE = parseInt(process.env.GRID_CELL_SIZE ?? "200", 10);
const PROXIMITY_THRESHOLD = parseFloat(process.env.PROXIMITY_CONFIDENCE_THRESHOLD ?? "0.75");
const THOUGHT_BUBBLE_COLOR = "#8B5CF6";
const NODE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
/** Map from Excalidraw type to our simplified node type. */
function mapNodeType(type) {
    if (type === "ellipse")
        return "ellipse";
    if (type === "diamond")
        return "diamond";
    return "box";
}
/** Get the center point of an element. */
function getCenter(el) {
    return { cx: el.x + el.width / 2, cy: el.y + el.height / 2 };
}
/** Euclidean distance between two center points. */
function distance(a, b) {
    return Math.sqrt((a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2);
}
/** Check if element A is geometrically contained within element B. */
function isContainedIn(inner, outer) {
    return (inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height);
}
/** Check if an element has the thought bubble visual style. */
function isThoughtBubbleStyle(el) {
    return (el.strokeStyle === "dashed" &&
        el.strokeColor?.toUpperCase() === THOUGHT_BUBBLE_COLOR.toUpperCase());
}
/** Get the text label for a container element by finding its bound text child. */
function getLabelForContainer(container, elementsById) {
    if (!container.boundElements)
        return "";
    for (const bound of container.boundElements) {
        if (bound.type === "text") {
            const textEl = elementsById.get(bound.id);
            if (textEl?.text)
                return textEl.text;
        }
    }
    return "";
}
/**
 * Analyze raw Excalidraw elements into a StructuredCanvas.
 */
export function analyzeCanvas(elements) {
    // Filter out deleted elements.
    const liveElements = elements.filter((el) => !el.isDeleted);
    // Build lookup map.
    const elementsById = new Map();
    for (const el of liveElements) {
        elementsById.set(el.id, el);
    }
    // Classify elements.
    const shapeElements = [];
    const arrowElements = [];
    const textElements = [];
    const freedrawElements = [];
    for (const el of liveElements) {
        if (NODE_TYPES.has(el.type)) {
            shapeElements.push(el);
        }
        else if (el.type === "arrow") {
            arrowElements.push(el);
        }
        else if (el.type === "text") {
            textElements.push(el);
        }
        else if (el.type === "freedraw") {
            freedrawElements.push(el);
        }
    }
    // --- Detect zones (large rectangles containing other elements) ---
    const zones = [];
    const zoneElementIds = new Set();
    // Sort shapes by area descending so we find containers first.
    const shapesByArea = [...shapeElements].sort((a, b) => b.width * b.height - a.width * a.height);
    for (const shape of shapesByArea) {
        if (shape.type !== "rectangle")
            continue;
        const label = getLabelForContainer(shape, elementsById);
        // A zone must contain at least one other shape element.
        const containedIds = [];
        for (const other of liveElements) {
            if (other.id === shape.id)
                continue;
            // Skip text labels that belong to this container.
            if (other.type === "text" && other.containerId === shape.id)
                continue;
            if (isContainedIn(other, shape)) {
                containedIds.push(other.id);
            }
        }
        if (containedIds.length > 0) {
            const isParkingLot = /parking\s*lot/i.test(label);
            zones.push({
                id: shape.id,
                label: label || "(unnamed zone)",
                is_parking_lot: isParkingLot,
                contained_element_ids: containedIds,
            });
            zoneElementIds.add(shape.id);
        }
    }
    // Build a map of element ID → containing zone ID.
    const elementToZone = new Map();
    for (const zone of zones) {
        for (const cid of zone.contained_element_ids) {
            // Innermost zone wins (zones are sorted largest-first, so later = smaller = more specific).
            elementToZone.set(cid, zone.id);
        }
    }
    // --- Extract nodes (shapes that are NOT zones, not thought bubbles, not parking lot items) ---
    const nodes = [];
    const nodeIds = new Set();
    const thoughtBubbleShapeIds = new Set();
    const parkingLotStickyIds = new Set();
    for (const shape of shapeElements) {
        if (zoneElementIds.has(shape.id))
            continue;
        const label = getLabelForContainer(shape, elementsById);
        if (!label)
            continue;
        // Thought-bubble-styled shapes go to thought_bubbles, not nodes.
        if (isThoughtBubbleStyle(shape)) {
            thoughtBubbleShapeIds.add(shape.id);
            continue;
        }
        // Shapes inside a parking lot zone are sticky notes, not nodes.
        const zoneId = elementToZone.get(shape.id);
        if (zoneId) {
            const zone = zones.find((z) => z.id === zoneId);
            if (zone?.is_parking_lot) {
                parkingLotStickyIds.add(shape.id);
                continue;
            }
        }
        const node = {
            id: shape.id,
            label,
            type: mapNodeType(shape.type),
            properties: [],
            thought_bubble: false,
            status: "active",
        };
        if (zoneId) {
            node.zone = zoneId;
        }
        const customData = shape.customData;
        if (customData && Object.keys(customData).length > 0) {
            node.metadata = customData;
        }
        nodes.push(node);
        nodeIds.add(shape.id);
    }
    // --- Extract edges (arrows with bindings) ---
    const edges = [];
    for (const arrow of arrowElements) {
        const arrowCustomData = (typeof arrow.customData === "object" && arrow.customData !== null)
            ? arrow.customData
            : undefined;
        const from = arrow.startBinding?.elementId
            ?? (arrowCustomData && typeof arrowCustomData.from === "string" ? arrowCustomData.from : undefined);
        const to = arrow.endBinding?.elementId
            ?? (arrowCustomData && typeof arrowCustomData.to === "string" ? arrowCustomData.to : undefined);
        if (!from || !to)
            continue;
        // Find label text bound to this arrow.
        let label;
        if (arrow.boundElements) {
            for (const bound of arrow.boundElements) {
                if (bound.type === "text") {
                    const textEl = elementsById.get(bound.id);
                    if (textEl?.text)
                        label = textEl.text;
                }
            }
        }
        const edgeObj = {
            id: arrow.id,
            from,
            to,
            label,
            thought_bubble: isThoughtBubbleStyle(arrow),
        };
        if (arrowCustomData && Object.keys(arrowCustomData).length > 0) {
            edgeObj.metadata = arrowCustomData;
        }
        edges.push(edgeObj);
    }
    // --- Floating text: proximity analysis + sticky notes ---
    const floatingTexts = textElements.filter((t) => !t.containerId);
    const stickyNotes = [];
    const maxProximityDistance = GRID_CELL_SIZE * 2;
    for (const ft of floatingTexts) {
        const ftCenter = getCenter(ft);
        let nearestNode = null;
        let nearestDist = Infinity;
        for (const node of nodes) {
            const nodeEl = elementsById.get(node.id);
            if (!nodeEl)
                continue;
            const d = distance(ftCenter, getCenter(nodeEl));
            if (d < nearestDist) {
                nearestDist = d;
                nearestNode = node;
            }
        }
        if (nearestNode && nearestDist < maxProximityDistance) {
            // Attach as a property with confidence.
            const confidence = Math.max(0, Math.min(1, 1 - nearestDist / maxProximityDistance));
            nearestNode.properties.push({
                text: ft.text ?? "",
                confidence,
                inferred: true,
            });
        }
        else {
            // Too far from any node — treat as a sticky note.
            const zoneId = elementToZone.get(ft.id);
            const zone = zoneId ? zones.find((z) => z.id === zoneId) : undefined;
            stickyNotes.push({
                id: ft.id,
                text: ft.text ?? "",
                status: zone?.is_parking_lot ? "parking_lot" : undefined,
                zone: zoneId,
            });
        }
    }
    // --- Grouped text+node: explicit properties ---
    for (const node of nodes) {
        const nodeEl = elementsById.get(node.id);
        if (!nodeEl || nodeEl.groupIds.length === 0)
            continue;
        for (const ft of floatingTexts) {
            if (!ft.containerId && ft.groupIds.length > 0) {
                // Check if they share a groupId.
                const sharedGroup = nodeEl.groupIds.some((gid) => ft.groupIds.includes(gid));
                if (sharedGroup) {
                    // Check not already added via proximity.
                    const alreadyAdded = node.properties.some((p) => p.text === ft.text);
                    if (!alreadyAdded) {
                        node.properties.push({
                            text: ft.text ?? "",
                            confidence: 1.0,
                            inferred: false,
                        });
                    }
                }
            }
        }
    }
    // --- Sticky notes from labeled shapes that aren't nodes, zones, or thought bubbles ---
    for (const shape of shapeElements) {
        if (zoneElementIds.has(shape.id))
            continue;
        if (nodeIds.has(shape.id))
            continue;
        if (thoughtBubbleShapeIds.has(shape.id))
            continue;
        const label = getLabelForContainer(shape, elementsById);
        const zoneId = elementToZone.get(shape.id);
        const zone = zoneId ? zones.find((z) => z.id === zoneId) : undefined;
        if (label) {
            stickyNotes.push({
                id: shape.id,
                text: label,
                status: zone?.is_parking_lot ? "parking_lot" : undefined,
                zone: zoneId,
            });
        }
    }
    // --- Thought bubbles ---
    const thoughtBubbles = [];
    for (const el of liveElements) {
        if (!isThoughtBubbleStyle(el))
            continue;
        if (el.type === "arrow")
            continue; // Arrows handled separately.
        const content = getLabelForContainer(el, elementsById) || el.text || "";
        // Find nearest node.
        const elCenter = getCenter(el);
        let nearestNodeId;
        let nearestDist = Infinity;
        for (const node of nodes) {
            const nodeEl = elementsById.get(node.id);
            if (!nodeEl)
                continue;
            const d = distance(elCenter, getCenter(nodeEl));
            if (d < nearestDist) {
                nearestDist = d;
                nearestNodeId = node.id;
            }
        }
        thoughtBubbles.push({
            id: el.id,
            content,
            position: nearestDist < maxProximityDistance ? "near" : "attached",
            related_node: nearestNodeId,
        });
    }
    // --- Freehand sketches ---
    const freehandSketches = [];
    for (const fd of freedrawElements) {
        const fdCenter = getCenter(fd);
        let nearestNodeId;
        let nearestDist = Infinity;
        for (const node of nodes) {
            const nodeEl = elementsById.get(node.id);
            if (!nodeEl)
                continue;
            const d = distance(fdCenter, getCenter(nodeEl));
            if (d < nearestDist) {
                nearestDist = d;
                nearestNodeId = node.id;
            }
        }
        freehandSketches.push({
            id: fd.id,
            related_node: nearestDist < maxProximityDistance ? nearestNodeId : undefined,
        });
    }
    return {
        nodes,
        edges,
        zones,
        sticky_notes: stickyNotes,
        thought_bubbles: thoughtBubbles,
        freehand_sketches: freehandSketches,
    };
}
//# sourceMappingURL=spatial.js.map