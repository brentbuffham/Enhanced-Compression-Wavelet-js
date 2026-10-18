// test/readRegion.test.js
//==========================================================
// EcwReader.readRegion over synthetic coded files.
// Run with: node --test test/readRegion.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openEcw } from "../src/EcwReader.js";
import { buildCodedFile } from "./helpers/buildCodedFile.js";
import { applyStretch, stretchFromPixels } from "../src/post/stretch.js";

// 64x48, 3 levels, 4x4 blocks; constant luma unless a coefficient function is given
function file(coeff) {
	return new Blob([buildCodedFile({ width: 64, height: 48, levelCount: 3, coeff: coeff || function (r, b, sb) { return r === 0 && b === 0 && sb === "LL" ? 100 : 0; } }).bytes]);
}
function pixel(img, x, y) { var i = (y * img.width + x) * 4; return Array.from(img.data.subarray(i, i + 4)); }

test("full-resolution read of a constant image", async function () {
	var ecw = await openEcw(file());
	var img = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48 });
	assert.equal(img.width, 64);
	assert.equal(img.height, 48);
	assert.equal(img.level, 3);
	assert.ok(img.data instanceof Uint8ClampedArray);
	assert.deepEqual(pixel(img, 0, 0), [101, 100, 101, 255]);
	assert.deepEqual(pixel(img, 63, 47), [101, 100, 101, 255]);
});

test("bounds come from the georeferencing", async function () {
	var ecw = await openEcw(file());
	var img = await ecw.readRegion({ x: 10, y: 20, width: 8, height: 4 });
	// buildEcwHeader defaults: origin 1000.25 / 5000.75, cell 0.5 / -0.5
	assert.deepEqual(img.bounds, { minX: 1005.25, minY: 4988.75, maxX: 1009.25, maxY: 4990.75 });
});

test("downsampled reads use the coarsest sharp-enough level", async function () {
	var ecw = await openEcw(file());
	assert.equal((await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, outWidth: 16, outHeight: 12 })).level, 1);
	assert.equal((await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, outWidth: 20, outHeight: 15 })).level, 2);
	assert.equal((await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, outWidth: 2, outHeight: 2 })).level, 0);
	var up = await ecw.readRegion({ x: 0, y: 0, width: 4, height: 4, outWidth: 8, outHeight: 8 });
	assert.equal(up.level, 3);
	assert.equal(up.width, 8);
});

test("a downsampled read samples the level nearest each output pixel", async function () {
	// band-0 LL ramps with x on record 0, so coarse output must ramp too
	var ecw = await openEcw(file(function (r, b, sb, x) { return r === 0 && b === 0 && sb === "LL" ? 10 * x : 0; }));
	var img = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, outWidth: 8, outHeight: 6 });
	assert.equal(img.level, 0);
	assert.deepEqual([0, 1, 7].map(function (x) { return pixel(img, x, 0)[1]; }), [0, 10, 70]);
});

test("resample average blends the level pixels each output pixel covers", async function () {
	var ecw = await openEcw(file(function (r, b, sb, x) { return r === 0 && b === 0 && sb === "LL" ? 10 * x : 0; }));
	// 64 -> 6 columns: factor 10.67 picks level 0 (8 wide), each output pixel covers 1.33 level pixels
	var near = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, outWidth: 6, outHeight: 6 });
	var avg = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, outWidth: 6, outHeight: 6, resample: "average" });
	assert.equal(avg.level, near.level);
	// output column 1 covers level x 1.33..2.67: (0.67 * 10 + 0.67 * 20) / 1.33 = 15
	assert.equal(pixel(near, 1, 0)[1], 20);
	assert.equal(pixel(avg, 1, 0)[1], 15);
});

test("an unknown resample mode throws INVALID_ARGUMENT", async function () {
	var ecw = await openEcw(file());
	await assert.rejects(ecw.readRegion({ x: 0, y: 0, width: 8, height: 8, resample: "cubic" }), { code: "INVALID_ARGUMENT" });
});

test("transparentBelow and clipPolygon apply to the output", async function () {
	var ecw = await openEcw(file());
	var img = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, transparentBelow: 120 });
	assert.equal(pixel(img, 5, 5)[3], 0);
	var clipped = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, clipPolygon: [[[1000.25, 5000.75], [1010.25, 5000.75], [1010.25, 4990.75]]] });
	assert.equal(pixel(clipped, 1, 0)[3], 255);
	assert.equal(pixel(clipped, 60, 40)[3], 0);
});

test("progress ends at 1", async function () {
	var ecw = await openEcw(file());
	var calls = [];
	await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, onProgress: function (f, label) { calls.push(f); } });
	assert.ok(calls.length > 1);
	assert.equal(calls.at(-1), 1);
	assert.ok(calls.every(function (f, i) { return f >= 0 && f <= 1 && (i === 0 || f >= calls[i - 1]); }));
});

test("invalid windows throw INVALID_ARGUMENT", async function () {
	var ecw = await openEcw(file());
	for (var bad of [{ x: -1, y: 0, width: 4, height: 4 }, { x: 0, y: 0, width: 0, height: 4 }, { x: 60, y: 0, width: 8, height: 4 },
		{ x: 0, y: 0, width: 4, height: 4, outWidth: 0 }, { x: 0.5, y: 0, width: 4, height: 4 }, {}]) {
		await assert.rejects(ecw.readRegion(bad), { code: "INVALID_ARGUMENT" }, JSON.stringify(bad));
	}
});

test("outputs above maxOutputBytes throw OUTPUT_TOO_LARGE before decoding", async function () {
	var ecw = await openEcw(file());
	await assert.rejects(ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, maxOutputBytes: 1000 }), { code: "OUTPUT_TOO_LARGE" });
});

test("an aborted signal rejects with ABORTED", async function () {
	var ecw = await openEcw(file());
	var c = new AbortController();
	c.abort();
	await assert.rejects(ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, signal: c.signal }), { code: "ABORTED" });
});

test("stretch is applied after colour, transparency is judged on the original values", async function () {
	var ecw = await openEcw(file(function (r, b, sb, x) { return r === 0 && b === 0 && sb === "LL" ? 10 * x : 0; }));
	var s = { min: [0, 0, 0], max: [80, 80, 80] };
	var plain = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48 });
	var stretched = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, stretch: s });
	assert.deepEqual(Array.from(stretched.data), Array.from(applyStretch(plain.data.slice(), s)));
	var both = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, stretch: s, transparentBelow: 1 });
	assert.equal(pixel(both, 0, 0)[3], 0, "near-black background still transparent");
	assert.equal(pixel(both, 63, 0)[3], 255);
	await assert.rejects(ecw.readRegion({ x: 0, y: 0, width: 8, height: 8, stretch: { min: [9, 9, 9], max: [1, 1, 1] } }), { code: "INVALID_ARGUMENT" });
});

test("computeStretch takes the cumulative cut from a small overview", async function () {
	var ecw = await openEcw(file(function (r, b, sb, x, y) { return r === 0 && sb === "LL" ? [40 + 9 * x + 3 * y, 6, -4][b] : 0; }));
	var s = await ecw.computeStretch({ cut: [2, 98], sampleSize: 16 });
	var thumb = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, outWidth: 16, outHeight: 12 });
	assert.deepEqual(s, stretchFromPixels(thumb.data, { cut: [2, 98], ignoreBelow: 3 }));
	assert.ok(s.max[1] > s.min[1]);
});
