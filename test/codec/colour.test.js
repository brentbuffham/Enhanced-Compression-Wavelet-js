// test/codec/colour.test.js
//==========================================================
// YCbCr -> RGBA (FINDINGS.md "inverse wavelet and colour"):
// BT.601 with +0.5 on R and B (closest match to GDAL so far), rounded,
// clamped, alpha 255. One-band files map to grey.
// Run with: node --test test/codec/colour.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { yuvToRgba, greyToRgba } from "../../src/codec/colour.js";

function one(y, u, v) {
	var out = new Uint8ClampedArray(4);
	yuvToRgba(Float32Array.of(y), Float32Array.of(u), Float32Array.of(v), out);
	return Array.from(out);
}

test("all-zero coefficients give the SDK's near-black (1, 0, 1)", function () {
	assert.deepEqual(one(0, 0, 0), [1, 0, 1, 255]);
});

test("BT.601 conversion with R and B offsets", function () {
	// R = 100 + 1.402*20 + 0.5 = 128.54 -> 129; G = 100 - 0.344136*-10 - 0.714136*20 = 89.16 -> 89; B = 100 + 1.772*-10 + 0.5 = 82.78 -> 83
	assert.deepEqual(one(100, -10, 20), [129, 89, 83, 255]);
});

test("values clamp to 0..255", function () {
	assert.deepEqual(one(300, 0, 0), [255, 255, 255, 255]);
	assert.deepEqual(one(300, 50, 50), [255, 247, 255, 255]);
	assert.deepEqual(one(-40, 0, 0), [0, 0, 0, 255]);
});

test("converts every pixel of an array", function () {
	var out = new Uint8ClampedArray(8);
	yuvToRgba(Float32Array.of(0, 200), Float32Array.of(0, 0), Float32Array.of(0, 0), out);
	assert.deepEqual(Array.from(out), [1, 0, 1, 255, 201, 200, 201, 255]);
});

test("greyToRgba copies the rounded band into R, G and B", function () {
	var out = new Uint8ClampedArray(8);
	greyToRgba(Float32Array.of(12.4, 300), out);
	assert.deepEqual(Array.from(out), [12, 12, 12, 255, 255, 255, 255, 255]);
});
