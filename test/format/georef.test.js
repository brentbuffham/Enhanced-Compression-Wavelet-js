// test/format/georef.test.js
//==========================================================
// pixelWindowToBounds: pixel window -> map bounds.
// Run with: node --test test/format/georef.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pixelWindowToBounds } from "../../src/format/georef.js";

test("bounds of the full image, north-up", function () {
	var info = { originX: 1000, originY: 5000, cellSizeX: 0.5, cellSizeY: -0.5 };
	assert.deepEqual(pixelWindowToBounds(info, 0, 0, 1000, 600), { minX: 1000, minY: 4700, maxX: 1500, maxY: 5000 });
});

test("bounds of an inner window, north-up", function () {
	var info = { originX: 1000, originY: 5000, cellSizeX: 0.5, cellSizeY: -0.5 };
	assert.deepEqual(pixelWindowToBounds(info, 10, 20, 4, 6), { minX: 1005, minY: 4987, maxX: 1007, maxY: 4990 });
});

test("bounds with positive cellSizeY", function () {
	var info = { originX: 0, originY: 0, cellSizeX: 0.5, cellSizeY: 0.5 };
	assert.deepEqual(pixelWindowToBounds(info, 0, 2, 2, 4), { minX: 0, minY: 1, maxX: 1, maxY: 3 });
});
