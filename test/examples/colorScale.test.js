// test/examples/colorScale.test.js
//==========================================================
// Log-scaled block-size colours for the demo's block map.
// Run with: node --test test/examples/colorScale.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockSizeColor, sizeRange, COLOR_STOPS } from "../../examples/browser/lib/colorScale.js";

test("sizeRange ignores zero sizes", function () {
	assert.deepEqual(sizeRange(Uint32Array.from([0, 10, 1000, 0])), { minLog: Math.log(10), maxLog: Math.log(1000) });
	assert.deepEqual(sizeRange(Uint32Array.from([0, 0])), { minLog: 0, maxLog: 0 });
});

test("endpoints map to the first and last colour stops", function () {
	var r = sizeRange(Uint32Array.from([10, 1000]));
	assert.deepEqual(blockSizeColor(10, r.minLog, r.maxLog), COLOR_STOPS[0]);
	assert.deepEqual(blockSizeColor(1000, r.minLog, r.maxLog), COLOR_STOPS[COLOR_STOPS.length - 1]);
});

test("brightness rises with block size", function () {
	var r = sizeRange(Uint32Array.from([10, 100000]));
	var last = -1;
	[10, 50, 300, 2000, 20000, 100000].forEach(function (size) {
		var c = blockSizeColor(size, r.minLog, r.maxLog);
		var sum = c[0] + c[1] + c[2];
		assert.ok(sum > last, "size " + size);
		last = sum;
	});
});

test("zero size is black; equal range gives the top colour", function () {
	assert.deepEqual(blockSizeColor(0, 1, 5), [0, 0, 0]);
	assert.deepEqual(blockSizeColor(50, Math.log(50), Math.log(50)), COLOR_STOPS[COLOR_STOPS.length - 1]);
});
