// test/codec/colour.test.js
//==========================================================
// YCbCr -> RGBA exactly as the ECW SDK does it (FINDINGS.md "colour
// conversion"): floor Y, Cb, Cr to integers, then
//   R = Y + T_R(Cr), G = Y + T_GB(Cb) + T_GR(Cr), B = Y + T_B(Cb)
// with each table t(c) = floor(k*c + offset + 0.5), clamped, alpha 255.
// Run with: node --test test/codec/colour.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { yuvToRgba, greyToRgba, colourTables } from "../../src/codec/colour.js";

function one(y, u, v) {
	var out = new Uint8ClampedArray(4);
	yuvToRgba(Float32Array.of(y), Float32Array.of(u), Float32Array.of(v), out);
	return Array.from(out);
}

test("all-zero coefficients give the SDK's near-black (1, 0, 1)", function () {
	assert.deepEqual(one(0, 0, 0), [1, 0, 1, 255]);
});

test("table entries around zero chroma", function () {
	var t = colourTables();
	assert.deepEqual([-2, -1, 0, 1, 2].map(t.R), [-2, 0, 1, 2, 4]);
	assert.deepEqual([-2, -1, 0, 1, 2].map(t.B), [-3, -1, 1, 3, 5]);
	assert.deepEqual([-2, -1, 0, 1, 2].map(t.GB), [1, 0, 0, 0, -1]);
	assert.deepEqual([-2, -1, 0, 1, 2].map(t.GR), [1, 1, 0, -1, -1]);
});

test("table extremes", function () {
	var t = colourTables();
	assert.deepEqual([t.R(-128), t.R(127)], [-178, 179]);
	assert.deepEqual([t.B(-128), t.B(127)], [-226, 226]);
	assert.deepEqual([t.GB(-128), t.GB(127)], [44, -44]);
	assert.deepEqual([t.GR(-128), t.GR(127)], [91, -91]);
});

test("Cb = -16 rounds to 5 and +16 to -6 (the asymmetry plain BT.601 misses)", function () {
	var t = colourTables();
	assert.equal(t.GB(-16), 5);
	assert.equal(t.GB(16), -6);
});

test("fractional inputs are floored before the tables", function () {
	// floor -> Y 100, Cb -11, Cr 20: R = 100 + 29 = 129; G = 100 + 4 - 14 = 90; B = 100 - 18 = 82
	assert.deepEqual(one(100.7, -10.2, 20.9), [129, 90, 82, 255]);
	var t = colourTables();
	assert.deepEqual(one(100.99, 0.5, -0.5), [100 + t.R(-1), 100 + t.GB(0) + t.GR(-1), 100 + t.B(0), 255]);
});

test("values clamp to 0..255", function () {
	assert.deepEqual(one(300, 0, 0), [255, 255, 255, 255]);
	assert.deepEqual(one(-40, 0, 0), [0, 0, 0, 255]);
});

test("converts every pixel of an array", function () {
	var out = new Uint8ClampedArray(8);
	yuvToRgba(Float32Array.of(0, 200), Float32Array.of(0, 0), Float32Array.of(0, 0), out);
	assert.deepEqual(Array.from(out), [1, 0, 1, 255, 201, 200, 201, 255]);
});

test("greyToRgba floors and copies the band into R, G and B", function () {
	var out = new Uint8ClampedArray(8);
	greyToRgba(Float32Array.of(12.9, 300), out);
	assert.deepEqual(Array.from(out), [12, 12, 12, 255, 255, 255, 255, 255]);
});
