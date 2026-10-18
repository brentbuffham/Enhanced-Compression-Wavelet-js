// test/decode/sampleWindow.test.js
//==========================================================
// Sampling a decoded level window to the output grid:
// "nearest" (the level pixel under each output pixel centre, as GDAL)
// and "average" (area-weighted box average over each output pixel).
// Run with: node --test test/decode/sampleWindow.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleWindow } from "../../src/decode/sampleWindow.js";

function region(width, height) { return { x: 0, y: 0, width: width, height: height }; }
function run(values, winW, winH, outW, outH, mode, scale) {
	var out = sampleWindow([Float32Array.from(values)], winW, winH, region(winW * (scale || 1), winH * (scale || 1)), scale || 1, 0, 0, outW, outH, mode);
	return Array.from(out[0]).map(function (v) { return Math.round(v * 1000) / 1000; });
}

test("nearest takes the level pixel under each output pixel centre", function () {
	assert.deepEqual(run([10, 20, 30, 40], 4, 1, 2, 1, "nearest"), [20, 40]);
});

test("average takes the mean of whole pixels", function () {
	assert.deepEqual(run([10, 20, 30, 40], 4, 1, 2, 1, "average"), [15, 35]);
});

test("average weights partly covered pixels by area", function () {
	// boxes [0, 1.5) and [1.5, 3)
	assert.deepEqual(run([10, 20, 30], 3, 1, 2, 1, "average"), [13.333, 26.667]);
});

test("average works in both directions", function () {
	assert.deepEqual(run([10, 20, 30, 40], 2, 2, 1, 1, "average"), [25]);
});

test("average when enlarging repeats each level pixel", function () {
	assert.deepEqual(run([10, 20], 2, 1, 4, 1, "average"), [10, 10, 20, 20]);
});

test("a window offset in a coarser level maps through the scale", function () {
	// level pixels 2..5 of a level at scale 2; region x 4..12 full resolution -> level 2..6
	var out = sampleWindow([Float32Array.from([10, 20, 30, 40])], 4, 1, { x: 4, y: 0, width: 8, height: 2 }, 2, 2, 0, 2, 1, "average");
	assert.deepEqual(Array.from(out[0]), [15, 35]);
});
