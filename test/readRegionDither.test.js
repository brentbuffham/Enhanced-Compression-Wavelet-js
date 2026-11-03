// test/readRegionDither.test.js
//==========================================================
// The SDK's output dither (src/codec/dither.js) over synthetic
// coded files: when it applies, where it is indexed, the opt-out.
// Run with: node --test test/readRegionDither.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openEcw } from "../src/EcwReader.js";
import { ditherBand, addDither, ditherTableEighths } from "../src/codec/dither.js";
import { buildCodedFile } from "./helpers/buildCodedFile.js";

var TABLE = ditherTableEighths();

// 128x128, 4x4 blocks, constant luma 100 (chroma 0, so G is luma)
function file(o) {
	o = o || {};
	var bands = o.bands || 3;
	return new Blob([buildCodedFile({
		width: 128, height: 128, levelCount: o.levelCount || 5, bands: bands, colorSpace: o.colorSpace,
		compressionTarget: o.target === undefined ? 10 : o.target,
		coeff: function (r, b, sb) { return r === 0 && b === 0 && sb === "LL" ? 100 : 0; }
	}).bytes]);
}

// The value floor(100 + table) a dithered level pixel (lx, ly) should have
function dithered(lx, ly) {
	return 100 + Math.floor(TABLE[(ly & 63) * 64 + (lx & 63)] / 8);
}

function green(img, x, y) { return img.data[(y * img.width + x) * 4 + 1]; }

test("the table: 64x64 eighths from -5 to +5, pinned", function () {
	assert.equal(TABLE.length, 4096);
	assert.equal(Math.min.apply(null, TABLE), -40);
	assert.equal(Math.max.apply(null, TABLE), 40);
	assert.deepEqual(Array.from(TABLE.subarray(0, 8)), [40, 27, -11, 5, -12, -34, 36, -30]);
	assert.deepEqual(Array.from(TABLE.subarray(4088)), [-37, -23, -32, 31, 38, -26, -30, -9]);
	var sum = 0;
	for (var i = 0; i < TABLE.length; i++) sum += (i + 1) * TABLE[i];
	assert.equal(sum, 5060110);
});

test("ditherBand: target 10+, 5+ levels, the finest three, yuv luma or greyscale", function () {
	var h = { compressionTarget: 10, levelCount: 10, bands: 3, colorSpace: "yuv" };
	assert.equal(ditherBand(h, 10), 0);
	assert.equal(ditherBand(h, 8), 0);
	assert.equal(ditherBand(h, 7), -1);
	assert.equal(ditherBand(Object.assign({}, h, { compressionTarget: 9 }), 10), -1);
	assert.equal(ditherBand(Object.assign({}, h, { compressionTarget: 255 }), 10), 0);
	assert.equal(ditherBand(Object.assign({}, h, { levelCount: 4 }), 4), -1);
	assert.equal(ditherBand(Object.assign({}, h, { levelCount: 5 }), 3), 0);
	assert.equal(ditherBand(Object.assign({}, h, { bands: 1, colorSpace: "greyscale" }), 10), 0);
	assert.equal(ditherBand(Object.assign({}, h, { colorSpace: "multiband" }), 10), -1);
	assert.equal(ditherBand(Object.assign({}, h, { colorSpace: "rgb" }), 10), -1);
});

test("addDither is indexed by position in the level, not in the window", function () {
	var whole = new Float32Array(100 * 90);
	addDither(whole, 100, 90, 0, 0);
	var part = new Float32Array(30 * 20);
	addDither(part, 30, 20, 37, 61);
	for (var y = 0; y < 20; y++) for (var x = 0; x < 30; x++) assert.equal(part[y * 30 + x], whole[(y + 61) * 100 + x + 37]);
	assert.equal(whole[0], 5);
	assert.equal(whole[64], 5);
	assert.equal(whole[64 * 100], 5);
});

test("full resolution of a target-10 file is dithered luma", async function () {
	var ecw = await openEcw(file());
	var img = await ecw.readRegion({ x: 0, y: 0, width: 128, height: 128 });
	for (var y = 0; y < 128; y++) for (var x = 0; x < 128; x++) assert.equal(green(img, x, y), dithered(x, y));
	// the same shift on all three channels
	var i = 0;
	assert.equal(img.data[i] - img.data[i + 1], 1);
	assert.equal(img.data[i + 2] - img.data[i + 1], 1);
});

test("an offset window matches the same pixels of a full read", async function () {
	var ecw = await openEcw(file());
	var img = await ecw.readRegion({ x: 37, y: 11, width: 50, height: 70 });
	for (var y = 0; y < 70; y++) for (var x = 0; x < 50; x++) assert.equal(green(img, x, y), dithered(x + 37, y + 11));
});

test("reduced reads: the finest three levels are dithered at level coordinates, coarser ones are not", async function () {
	var ecw = await openEcw(file());
	// level 3 of 5 (1/4 size): dithered, indexed by level-3 pixel
	var l3 = await ecw.readRegion({ x: 0, y: 0, width: 128, height: 128, outWidth: 32, outHeight: 32 });
	assert.equal(l3.level, 3);
	for (var y = 0; y < 32; y++) for (var x = 0; x < 32; x++) assert.equal(green(l3, x, y), dithered(x, y));
	// level 2 (1/8 size): clean
	var l2 = await ecw.readRegion({ x: 0, y: 0, width: 128, height: 128, outWidth: 16, outHeight: 16 });
	assert.equal(l2.level, 2);
	for (var i = 0; i < 16 * 16; i++) assert.equal(l2.data[i * 4 + 1], 100);
});

test("no dither below target 10, below 5 levels, or with dither: false", async function () {
	var cases = [
		{ ecw: await openEcw(file({ target: 9 })), opts: {} },
		{ ecw: await openEcw(file({ levelCount: 4 })), opts: {} },
		{ ecw: await openEcw(file()), opts: { dither: false } }
	];
	for (var c = 0; c < cases.length; c++) {
		var img = await cases[c].ecw.readRegion(Object.assign({ x: 0, y: 0, width: 128, height: 128 }, cases[c].opts));
		for (var i = 0; i < 128 * 128; i++) assert.equal(img.data[i * 4 + 1], 100, "case " + c);
	}
});

test("greyscale is dithered; multiband is not", async function () {
	var grey = await openEcw(file({ bands: 1, colorSpace: 1 }));
	var g = await grey.readRegion({ x: 0, y: 0, width: 128, height: 128 });
	for (var y = 0; y < 128; y++) for (var x = 0; x < 128; x++) assert.equal(green(g, x, y), dithered(x, y));
	var multi = await openEcw(file({ colorSpace: 3 }));
	var m = await multi.readRegion({ x: 0, y: 0, width: 128, height: 128 });
	for (var i = 0; i < 128 * 128; i++) assert.equal(m.data[i * 4], 100);
});

test("dither must be a boolean", async function () {
	var ecw = await openEcw(file());
	await assert.rejects(ecw.readRegion({ x: 0, y: 0, width: 8, height: 8, dither: "no" }), { code: "INVALID_ARGUMENT" });
});
