// test/post/stretch.test.js
//==========================================================
// Optional contrast stretch (display enhancement, like QGIS's
// min/max stretch with a cumulative count cut): per band,
// min -> 0 and max -> 255, linear between, clamped.
// Run with: node --test test/post/stretch.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStretch, stretchFromPixels } from "../../src/post/stretch.js";

function px(list) { return Uint8ClampedArray.from(list); }

test("each band maps its min to 0 and max to 255, linearly", function () {
	var s = { min: [10, 20, 0], max: [110, 220, 255] };
	assert.deepEqual(Array.from(applyStretch(px([10, 20, 0, 255, 60, 120, 128, 255, 110, 220, 255, 255]), s)),
		[0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
});

test("values outside the range clamp; alpha is untouched", function () {
	var s = { min: [50, 50, 50], max: [100, 100, 100] };
	assert.deepEqual(Array.from(applyStretch(px([0, 49, 200, 7]), s)), [0, 0, 255, 7]);
});

test("a stretch with max <= min or the wrong shape throws INVALID_ARGUMENT", function () {
	assert.throws(function () { applyStretch(px([1, 2, 3, 255]), { min: [5, 5, 5], max: [5, 9, 9] }); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { applyStretch(px([1, 2, 3, 255]), { min: [0, 0], max: [9, 9] }); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { applyStretch(px([1, 2, 3, 255]), null); }, { code: "INVALID_ARGUMENT" });
});

test("stretchFromPixels takes per-band cumulative cuts, skipping background and transparent pixels", function () {
	var list = [];
	for (var v = 0; v < 100; v++) list.push(v + 10, 2 * v + 10, 255 - v, 255);
	for (var k = 0; k < 500; k++) list.push(k % 3, 0, 1, 255); // near-black background
	list.push(250, 250, 250, 0); // transparent
	var s = stretchFromPixels(px(list), { cut: [2, 98], ignoreBelow: 3 });
	// 100 samples per band: the 2% and 98% points are the 2nd and 98th smallest
	assert.deepEqual(s, { min: [11, 12, 157], max: [107, 204, 253] });
	assert.deepEqual(stretchFromPixels(px(list), { cut: [0, 100], ignoreBelow: 3 }), { min: [10, 10, 156], max: [109, 208, 255] });
});

test("stretchFromPixels with no foreground pixels throws INVALID_ARGUMENT", function () {
	assert.throws(function () { stretchFromPixels(px([0, 0, 0, 255, 1, 2, 3, 255]), { ignoreBelow: 3 }); }, { code: "INVALID_ARGUMENT" });
});
