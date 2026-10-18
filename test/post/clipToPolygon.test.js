// test/post/clipToPolygon.test.js
//==========================================================
// clipPolygon: even-odd scanline fill of map-coordinate rings.
// Bounds 0..10 on both axes; pixel (c, r) centre is
// x = c + 0.5, y = 9.5 - r on a 10x10 grid (row 0 = maxY).
// Expected grids were worked out by hand before the code existed.
// Run with: node --test test/post/clipToPolygon.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipToPolygon } from "../../src/post/clipToPolygon.js";

var BOUNDS = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

function opaque(w, h) { return new Uint8ClampedArray(w * h * 4).fill(255); }
function alphaGrid(rgba, w, h) {
	var rows = [];
	for (var r = 0; r < h; r++) {
		var row = "";
		for (var c = 0; c < w; c++) row += rgba[(r * w + c) * 4 + 3] ? "1" : "0";
		rows.push(row);
	}
	return rows;
}
function clip(rings, w, h) { var n = w || 10, m = h || 10; return alphaGrid(clipToPolygon(opaque(n, m), n, m, BOUNDS, rings), n, m); }
function count(grid) { return grid.join("").split("1").length - 1; }

test("axis-aligned square keeps only centres inside", function () {
	var g = clip([[[2, 2], [8, 2], [8, 8], [2, 8]]]);
	assert.equal(count(g), 36);
	assert.equal(g[2], "0011111100");
	assert.equal(g[1], "0000000000");
	assert.equal(g[8], "0000000000");
});

test("edge exactly through pixel centres follows the half-open rule", function () {
	var g = clip([[[2.5, 0], [7.5, 0], [7.5, 10], [2.5, 10]]]);
	g.forEach(function (row) { assert.equal(row, "0011111000"); });
});

test("concave L-shape", function () {
	assert.deepEqual(clip([[[1, 1], [9, 1], [9, 4], [4, 4], [4, 9], [1, 9]]]), [
		"0000000000",
		"0111000000",
		"0111000000",
		"0111000000",
		"0111000000",
		"0111000000",
		"0111111110",
		"0111111110",
		"0111111110",
		"0000000000"
	]);
});

test("inner ring makes a hole", function () {
	var g = clip([[[1, 1], [9, 1], [9, 9], [1, 9]], [[4, 4], [6, 4], [6, 6], [4, 6]]]);
	assert.equal(count(g), 60);
	assert.equal(g[4], "0111001110");
	assert.equal(g[5], "0111001110");
	assert.equal(g[3], "0111111110");
});

test("ring entirely outside clears everything", function () {
	assert.equal(count(clip([[[20, 20], [30, 20], [30, 30]]])), 0);
});

test("self-crossing ring (bow-tie) uses even-odd", function () {
	assert.deepEqual(clip([[[1, 1], [9, 9], [9, 1], [1, 9]]]), [
		"0000000000",
		"0000000010",
		"0100000110",
		"0110001110",
		"0111011110",
		"0111011110",
		"0110001110",
		"0100000110",
		"0000000010",
		"0000000000"
	]);
});

test("empty rings is a no-op", function () {
	assert.equal(count(clip([])), 100);
});

test("scaled output maps output pixel centres through bounds", function () {
	assert.deepEqual(clip([[[2, 2], [8, 2], [8, 8], [2, 8]]], 5, 5), ["00000", "01110", "01110", "01110", "00000"]);
});

test("north-up: row 0 is maxY", function () {
	var g = clip([[[0, 5], [10, 5], [5, 10]]]);
	assert.equal(g[0], "0000100000");
	assert.equal(g[4], "1111111110");
	for (var r = 5; r < 10; r++) assert.equal(g[r], "0000000000");
});

test("RGB values are left untouched", function () {
	var rgba = opaque(10, 10).fill(7);
	clipToPolygon(rgba, 10, 10, BOUNDS, [[[20, 20], [30, 20], [30, 30]]]);
	assert.deepEqual(Array.from(rgba.subarray(0, 4)), [7, 7, 7, 0]);
});

test("invalid ring throws INVALID_ARGUMENT", function () {
	assert.throws(function () { clip([[[0, 0], [1, 1]]]); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { clip([[[0, 0], [NaN, 1], [2, 2]]]); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { clip("not rings"); }, { code: "INVALID_ARGUMENT" });
});

test("firstRow clips a strip exactly as the same rows of the whole image", function () {
	var rings = [[[0.3, 0.2], [7.9, 1.1], [3.2, 7.7]]];
	var bounds = { minX: 0, minY: 0, maxX: 8, maxY: 8 };
	var whole = clipToPolygon(new Uint8ClampedArray(8 * 8 * 4).fill(255), 8, 8, bounds, rings);
	var strip = clipToPolygon(new Uint8ClampedArray(8 * 3 * 4).fill(255), 8, 8, bounds, rings, 4);
	assert.deepEqual(Array.from(strip), Array.from(whole.subarray(8 * 4 * 4, 8 * 7 * 4)));
});
