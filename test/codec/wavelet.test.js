// test/codec/wavelet.test.js
//==========================================================
// Windowed inverse wavelet (FINDINGS.md "inverse wavelet"):
// even = s[k] - (d[k-1] + d[k]) / 2, odd = (s[k] + s[k+1]) / 2 + d[k],
// rows first (HL high-pass), then columns (LH / HH), edges clamped.
// Run with: node --test test/codec/wavelet.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeWindow, requiredCoefficientWindow } from "../../src/codec/wavelet.js";

function planes(w, h, fill) {
	var p = { w: w, h: h, x0: 0, y0: 0, width: w, height: h };
	["LL", "LH", "HL", "HH"].forEach(function (sb) { p[sb] = new Float32Array(w * h).fill(fill && fill[sb] || 0); });
	return p;
}

test("requiredCoefficientWindow pads by one and clamps to the level", function () {
	assert.deepEqual(requiredCoefficientWindow(10, 8, 4, 4, 8, 6), { x0: 1, y0: 1, x1: 5, y1: 4 });
	assert.deepEqual(requiredCoefficientWindow(10, 8, 0, 0, 20, 16), { x0: 0, y0: 0, x1: 10, y1: 8 });
});

test("constant LL with zero details stays constant", function () {
	var out = synthesizeWindow(planes(4, 3, { LL: 37 }), 0, 0, 8, 6);
	assert.equal(out.length, 48);
	assert.ok(out.every(function (v) { return v === 37; }));
});

test("one HL coefficient gives the hand-computed pattern", function () {
	var p = planes(4, 4);
	p.HL[1 * 4 + 1] = 4;
	var out = synthesizeWindow(p, 0, 0, 8, 8);
	function at(x, y) { return out[y * 8 + x]; }
	// row pass on coefficient row 1: [0, 0, -2, 4, -2, 0, 0, 0]; column pass spreads row 1 to output rows 1..3
	assert.equal(at(3, 2), 4);
	assert.equal(at(2, 2), -2);
	assert.equal(at(4, 2), -2);
	assert.equal(at(3, 1), 2);
	assert.equal(at(3, 3), 2);
	assert.equal(at(4, 1), -1);
	assert.equal(at(3, 0), 0);
	assert.equal(at(3, 4), 0);
	assert.equal(at(5, 2), 0);
});

test("one LH coefficient acts vertically", function () {
	var p = planes(4, 4);
	p.LH[1 * 4 + 1] = 4;
	var out = synthesizeWindow(p, 0, 0, 8, 8);
	function at(x, y) { return out[y * 8 + x]; }
	// LH row pass (low-pass in x) spreads to x 1..3, then LH is the column high-pass
	assert.equal(at(2, 3), 4);
	assert.equal(at(2, 2), -2);
	assert.equal(at(2, 4), -2);
	assert.equal(at(1, 3), 2);
});

test("edges clamp to the nearest coefficient", function () {
	var p = planes(2, 1);
	p.LL[0] = 10; p.LL[1] = 20; p.HL[0] = 2;
	var out = synthesizeWindow(p, 0, 0, 4, 1);
	// x0: 10 - (2 + 2)/2 = 8; x1: (10 + 20)/2 + 2 = 17; x2: 20 - (2 + 0)/2 = 19; x3: (20 + 20)/2 + 0 = 20
	assert.deepEqual(Array.from(out), [8, 17, 19, 20]);
});

test("a window equals the matching crop of the full synthesis", function () {
	var p = planes(9, 7);
	var seed = 7;
	["LL", "LH", "HL", "HH"].forEach(function (sb) { for (var i = 0; i < p[sb].length; i++) { seed = (seed * 1103515245 + 12345) % 2147483648; p[sb][i] = (seed % 41) - 20; } });
	var full = synthesizeWindow(p, 0, 0, 18, 14);
	var x0 = 5, y0 = 3, x1 = 13, y1 = 11;
	var c = requiredCoefficientWindow(9, 7, x0, y0, x1, y1);
	var sub = { w: 9, h: 7, x0: c.x0, y0: c.y0, width: c.x1 - c.x0, height: c.y1 - c.y0 };
	["LL", "LH", "HL", "HH"].forEach(function (sb) {
		sub[sb] = new Float32Array(sub.width * sub.height);
		for (var y = 0; y < sub.height; y++) for (var x = 0; x < sub.width; x++) sub[sb][y * sub.width + x] = p[sb][(c.y0 + y) * 9 + c.x0 + x];
	});
	var win = synthesizeWindow(sub, x0, y0, x1, y1);
	for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) assert.equal(win[(y - y0) * (x1 - x0) + x - x0], full[y * 18 + x]);
});

test("missing coefficients for the window throw INVALID_ARGUMENT", function () {
	var p = planes(4, 4);
	p.x0 = 2; p.width = 2;
	assert.throws(function () { synthesizeWindow(p, 0, 0, 4, 4); }, { code: "INVALID_ARGUMENT" });
});

test("odd-odd pixels use vertical averages floored to quarters; even columns stay exact", function () {
	var p = planes(1, 2);
	p.LL[0] = 10.125; p.LL[1] = 10.25;
	var out = synthesizeWindow(p, 0, 0, 2, 4);
	// odd row 1: even column keeps the exact average 10.1875; odd column interpolates floor4(10.1875) = 10
	assert.deepEqual(Array.from(out), [10.125, 10.125, 10.1875, 10, 10.25, 10.25, 10.25, 10.25]);
});

test("horizontal averages stay exact", function () {
	var p = planes(2, 1);
	p.LL[0] = 10.125; p.LL[1] = 10.25;
	var out = synthesizeWindow(p, 0, 0, 4, 1);
	assert.deepEqual(Array.from(out), [10.125, 10.1875, 10.25, 10.25]);
});

test("subbandsAt(c, k) 0 switches a coefficient to the exact path", function () {
	var p = planes(1, 2);
	p.LL[0] = 10.125; p.LL[1] = 10.25;
	p.subbandsAt = function () { return 0; };
	var out = synthesizeWindow(p, 0, 0, 2, 4);
	assert.deepEqual(Array.from(out), [10.125, 10.125, 10.1875, 10.1875, 10.25, 10.25, 10.25, 10.25]);
});

test("the output pixel's block decides the path for both columns it interpolates", function () {
	var p = planes(2, 2);
	// column 0 rows 10.125 / 10.25, column 1 rows 20.125 / 20.25
	p.LL[0] = 10.125; p.LL[1] = 20.125; p.LL[2] = 10.25; p.LL[3] = 20.25;
	p.subbandsAt = function (c) { return c === 0 ? 7 : 0; };
	var out = synthesizeWindow(p, 0, 0, 4, 4);
	// row 1, x 1 sits in column 0's block (general): (floor4(10.1875) + floor4(20.1875)) / 2 = (10 + 20) / 2
	assert.equal(out[1 * 4 + 1], 15);
	// row 1, x 3 sits in column 1's block (exact): (20.1875 + 20.1875) / 2
	assert.equal(out[1 * 4 + 3], 20.1875);
});

test("exact-path pixels ignore all detail coefficients, including neighbouring blocks'", function () {
	var p = planes(2, 1);
	p.LL[0] = 10; p.LL[1] = 20; p.HL[0] = 4;
	p.subbandsAt = function (c) { return c === 0 ? 7 : 0; };
	var out = synthesizeWindow(p, 0, 0, 4, 1);
	// x0, x1 in column 0's block (general): 10 - (4 + 4) / 2 = 6; (10 + 20) / 2 + 4 = 19
	// x2, x3 in column 1's block (exact): pure LL interpolation, the neighbour's HL is not used: 20; 20
	assert.deepEqual(Array.from(out), [6, 19, 20, 20]);
});

test("a subband empty in the output pixel's block contributes nothing there, neighbours' coefficients included", function () {
	var p = planes(1, 2, { LL: 100 });
	p.HH[0] = 16; p.HL[1] = -40;
	// block of coefficient row 0 has only HH; block of row 1 has only HL
	p.subbandsAt = function (c, k) { return k === 0 ? 4 : 2; };
	var out = synthesizeWindow(p, 0, 0, 2, 4);
	// column high-pass per row: -16 (HH only), 16 (HH only, HL[1] ignored), -40 (HL only, HH[0] ignored), -40
	assert.deepEqual(Array.from(out), [116, 84, 84, 116, 140, 60, 140, 60]);
});

test("an empty LH in the output pixel's block drops the neighbour's LH too", function () {
	var p = planes(1, 2, { LL: 100 });
	p.LH[0] = 16;
	// row 0's block has LH; row 1's block has only HL (all zero)
	p.subbandsAt = function (c, k) { return k === 0 ? 1 : 2; };
	var out = synthesizeWindow(p, 0, 0, 2, 4);
	// rows: 100 - (16 + 16) / 2 = 84; 100 + 16 = 116; 100 (LH[0] dropped); 100
	assert.deepEqual(Array.from(out), [84, 84, 116, 116, 100, 100, 100, 100]);
});

test("matches the reference synthesis bit for bit on random windows, sizes and subband masks", async function () {
	var { referenceSynthesizeWindow } = await import("../helpers/referenceWavelet.js");
	var seed = 12345;
	// high bits: the low bits of a power-of-two LCG cycle too quickly
	function rnd(n) { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; }
	for (var t = 0; t < 300; t++) {
		var w = 1 + rnd(9), h = 1 + rnd(9);
		var p = planes(w, h);
		["LL", "LH", "HL", "HH"].forEach(function (sb) {
			for (var i = 0; i < p[sb].length; i++) p[sb][i] = sb === "LL" ? rnd(2001) / 8 - 50 : rnd(41) - 20 + (rnd(4) === 0 ? rnd(8) / 8 : 0);
		});
		if (t % 3) {
			var masks = new Int8Array(w * h).map(function () { return rnd(8); });
			p.subbandsAt = function (c, k) { return masks[k * w + c]; };
		}
		var x0 = rnd(2 * w), x1 = x0 + 1 + rnd(2 * w - x0), y0 = rnd(2 * h), y1 = y0 + 1 + rnd(2 * h - y0);
		var got = synthesizeWindow(p, x0, y0, x1, y1);
		var want = referenceSynthesizeWindow(p, x0, y0, x1, y1);
		assert.deepEqual(Array.from(got), Array.from(want), "case " + t + ": " + w + "x" + h + " window " + [x0, y0, x1, y1]);
		// and from a coefficient window that only just covers the output
		var c = requiredCoefficientWindow(w, h, x0, y0, x1, y1);
		var sub = { w: w, h: h, x0: c.x0, y0: c.y0, width: c.x1 - c.x0, height: c.y1 - c.y0, subbandsAt: p.subbandsAt };
		["LL", "LH", "HL", "HH"].forEach(function (sb) {
			sub[sb] = new Float32Array(sub.width * sub.height);
			for (var y = 0; y < sub.height; y++) for (var x = 0; x < sub.width; x++) sub[sb][y * sub.width + x] = p[sb][(c.y0 + y) * w + c.x0 + x];
		});
		assert.deepEqual(Array.from(synthesizeWindow(sub, x0, y0, x1, y1)), Array.from(want), "case " + t + " (tight window)");
	}
});
