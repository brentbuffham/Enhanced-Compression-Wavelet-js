// test/post/applyTransparency.test.js
//==========================================================
// transparentBelow: every band <= threshold -> alpha 0.
// Run with: node --test test/post/applyTransparency.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTransparency } from "../../src/post/applyTransparency.js";

function px(list) { return Uint8ClampedArray.from(list); }
function alphas(rgba) { var a = []; for (var i = 3; i < rgba.length; i += 4) a.push(rgba[i]); return a; }

test("all bands at threshold become transparent", function () {
	assert.deepEqual(alphas(applyTransparency(px([3, 3, 3, 255]), 3)), [0]);
});

test("one band above threshold stays opaque", function () {
	assert.deepEqual(alphas(applyTransparency(px([3, 4, 3, 255, 3, 3, 4, 255, 4, 3, 3, 255]), 3)), [255, 255, 255]);
});

test("threshold 0 only clears pure black", function () {
	assert.deepEqual(alphas(applyTransparency(px([0, 0, 0, 255, 1, 0, 1, 255]), 0)), [0, 255]);
});

test("existing alpha of kept pixels is preserved", function () {
	assert.deepEqual(alphas(applyTransparency(px([9, 9, 9, 128]), 3)), [128]);
});

test("RGB values are left untouched", function () {
	var out = applyTransparency(px([2, 1, 2, 255]), 3);
	assert.deepEqual(Array.from(out.subarray(0, 3)), [2, 1, 2]);
});

test("invalid threshold throws INVALID_ARGUMENT", function () {
	[-1, 256, 1.5, NaN, "3", undefined].forEach(function (t) {
		assert.throws(function () { applyTransparency(px([0, 0, 0, 255]), t); }, { code: "INVALID_ARGUMENT" }, String(t));
	});
});

test("returns the same array", function () {
	var rgba = px([0, 0, 0, 255]);
	assert.equal(applyTransparency(rgba, 3), rgba);
});
