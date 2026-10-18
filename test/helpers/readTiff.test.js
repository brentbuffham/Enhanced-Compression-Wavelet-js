// test/helpers/readTiff.test.js
//==========================================================
// The test-only TIFF reader used for GDAL reference parity.
// Run with: node --test test/helpers/readTiff.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readTiff } from "./readTiff.js";
import { writeTiff } from "./writeTiff.js";

var rgb = Uint8Array.from({ length: 3 * 2 * 3 }, function (_, i) { return i * 7; });

test("round-trips a 3x2 RGB image, little-endian, one strip", function () {
	var t = readTiff(writeTiff({ width: 3, height: 2, samplesPerPixel: 3, data: rgb }));
	assert.deepEqual({ width: t.width, height: t.height, samplesPerPixel: t.samplesPerPixel }, { width: 3, height: 2, samplesPerPixel: 3 });
	assert.deepEqual(Array.from(t.data), Array.from(rgb));
});

test("reads big-endian with multiple strips", function () {
	var t = readTiff(writeTiff({ width: 3, height: 2, samplesPerPixel: 3, data: rgb, bigEndian: true, rowsPerStrip: 1 }));
	assert.deepEqual(Array.from(t.data), Array.from(rgb));
});

test("reads single-band images", function () {
	var grey = Uint8Array.from([1, 2, 3, 4]);
	var t = readTiff(writeTiff({ width: 2, height: 2, samplesPerPixel: 1, data: grey }));
	assert.equal(t.samplesPerPixel, 1);
	assert.deepEqual(Array.from(t.data), [1, 2, 3, 4]);
});

test("rejects compressed TIFF", function () {
	assert.throws(function () { readTiff(writeTiff({ width: 3, height: 2, samplesPerPixel: 3, data: rgb, compression: 5 })); }, /unsupported TIFF: Compression/);
});

test("rejects non-TIFF bytes", function () {
	assert.throws(function () { readTiff(Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0])); }, /unsupported TIFF: byte order/);
});
