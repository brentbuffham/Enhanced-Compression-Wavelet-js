// test/examples/viewMath.test.js
//==========================================================
// Screen <-> map transforms for the demo viewer.
// Picture pixels span `bounds`; the canvas draws the picture at
// `scale` with top-left at (offsetX, offsetY). Row 0 is maxY.
// Run with: node --test test/examples/viewMath.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { screenToMap, mapToScreen } from "../../examples/browser/lib/viewMath.js";

var VIEW = { bounds: { minX: 100, minY: 200, maxX: 300, maxY: 300 }, width: 20, height: 10, scale: 4, offsetX: 10, offsetY: 5 };

test("picture corners map to bounds corners", function () {
	assert.deepEqual(screenToMap(VIEW, 10, 5), { x: 100, y: 300 });
	assert.deepEqual(screenToMap(VIEW, 10 + 20 * 4, 5 + 10 * 4), { x: 300, y: 200 });
});

test("mapToScreen inverts screenToMap", function () {
	var p = mapToScreen(VIEW, 175, 260);
	var back = screenToMap(VIEW, p.x, p.y);
	assert.ok(Math.abs(back.x - 175) < 1e-9 && Math.abs(back.y - 260) < 1e-9);
});

test("mapToScreen of the bounds centre is the picture centre", function () {
	assert.deepEqual(mapToScreen(VIEW, 200, 250), { x: 10 + 40, y: 5 + 20 });
});
