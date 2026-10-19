// test/readRegionToScratch.test.js
//==========================================================
// EcwReader.readRegionToScratch: strips streamed into an OPFS
// scratch file (fake OPFS root), byte-identical to readRegion.
// Run with: node --test test/readRegionToScratch.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openEcw } from "../src/EcwReader.js";
import { listScratchFiles } from "../src/io/ScratchBinaryFile.js";
import { buildCodedFile } from "./helpers/buildCodedFile.js";
import { createFakeRoot } from "./helpers/fakeOpfs.js";

// 64x48, 3 levels, 4x4 blocks, with detail on every record so strips cross real synthesis
function file() {
	return new Blob([buildCodedFile({ width: 64, height: 48, levelCount: 3, coeff: function (r, b, sb, x, y) {
		if (sb === "LL") return [60 + 7 * x + 3 * y, 5 * (x % 3), -4 * (y % 2)][b];
		return ((x * 7 + y * 13 + r * 5 + b) % 9) - 4;
	} }).bytes]);
}

async function scratchBytes(out) {
	var reader = await out.openReader();
	var bytes = reader.slice(0, out.byteLength);
	reader.close();
	return bytes;
}

var CASES = [
	{ name: "full resolution", opts: { x: 0, y: 0, width: 64, height: 48 } },
	{ name: "downsampled nearest", opts: { x: 3, y: 5, width: 50, height: 40, outWidth: 19, outHeight: 13 } },
	{ name: "downsampled average", opts: { x: 3, y: 5, width: 50, height: 40, outWidth: 19, outHeight: 13, resample: "average" } },
	{ name: "clip and transparency", opts: { x: 0, y: 0, width: 64, height: 48, transparentBelow: 90,
		clipPolygon: [[[1000.25, 5000.75], [1030.25, 5000.75], [1010.25, 4980.75]]] } },
	{ name: "transparentAbove and transparentColor", opts: { x: 0, y: 0, width: 64, height: 48, transparentAbove: 200,
		transparentColor: [{ color: [90, 90, 90], below: 20, above: 20 }] } }
];

CASES.forEach(function (c) {
	test("readRegionToScratch equals readRegion: " + c.name, async function () {
		var root = createFakeRoot();
		var ecw = await openEcw(file());
		var mem = await ecw.readRegion(c.opts);
		// a tiny strip budget forces several strips
		var out = await ecw.readRegionToScratch(Object.assign({ scratch: { root: root }, stripBytes: (mem.width * 4) * 5 }, c.opts));
		assert.equal(out.width, mem.width);
		assert.equal(out.height, mem.height);
		assert.equal(out.level, mem.level);
		assert.deepEqual(out.bounds, mem.bounds);
		assert.equal(out.byteLength, mem.width * mem.height * 4);
		assert.deepEqual(await scratchBytes(out), new Uint8Array(mem.data.buffer));
	});
});

test("readRegionToScratch reports progress ending at 1", async function () {
	var ecw = await openEcw(file());
	var seen = [];
	await ecw.readRegionToScratch({ x: 0, y: 0, width: 64, height: 48, scratch: { root: createFakeRoot() }, stripBytes: 64 * 4 * 8,
		onProgress: function (f) { seen.push(f); } });
	assert.equal(seen[seen.length - 1], 1);
	for (var i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], "progress never goes backwards");
});

test("an aborted readRegionToScratch rejects with ABORTED and removes its file", async function () {
	var root = createFakeRoot();
	var ecw = await openEcw(file());
	var ac = new AbortController();
	var strips = 0;
	var p = ecw.readRegionToScratch({ x: 0, y: 0, width: 64, height: 48, scratch: { root: root }, stripBytes: 64 * 4 * 4, signal: ac.signal,
		onProgress: function (f, label) { if (/strip 2 /.test(label) && !strips++) ac.abort(); } });
	await assert.rejects(p, { code: "ABORTED" });
	assert.deepEqual(await listScratchFiles({ root: root }), []);
});

test("invalid readRegionToScratch arguments reject before creating a file", async function () {
	var root = createFakeRoot();
	var ecw = await openEcw(file());
	await assert.rejects(ecw.readRegionToScratch({ x: 0, y: 0, width: 65, height: 1, scratch: { root: root } }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(ecw.readRegionToScratch({ x: 0, y: 0, width: 8, height: 8, stripBytes: 0, scratch: { root: root } }), { code: "INVALID_ARGUMENT" });
	assert.deepEqual(await listScratchFiles({ root: root }), []);
});

test("close() removes the reader's scratch files", async function () {
	var root = createFakeRoot();
	var ecw = await openEcw(file());
	await ecw.readRegionToScratch({ x: 0, y: 0, width: 8, height: 8, scratch: { root: root } });
	await ecw.readRegionToScratch({ x: 8, y: 8, width: 8, height: 8, scratch: { root: root } });
	assert.equal((await listScratchFiles({ root: root })).length, 2);
	await ecw.close();
	assert.deepEqual(await listScratchFiles({ root: root }), []);
});
