// test/readRegionCache.test.js
//==========================================================
// openEcw cache option: reconstructed tiles reused across reads
// (memory by default, OPFS opt-in), pixels unchanged.
// Run with: node --test test/readRegionCache.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openEcw } from "../src/EcwReader.js";
import { blockCacheUsage } from "../src/cache/BlockCache.js";
import { buildCodedFile } from "./helpers/buildCodedFile.js";
import { createFakeRoot } from "./helpers/fakeOpfs.js";

var BYTES = buildCodedFile({ width: 64, height: 48, levelCount: 3, coeff: function (r, b, sb, x, y) {
	return sb === "LL" ? [60 + 5 * x + 2 * y, 4, -3][b] : ((x * 3 + y * 5 + r + b) % 7) - 3;
} }).bytes;

// A File that counts the byte ranges read from it
function countingFile() {
	var f = new File([BYTES], "synthetic.ecw", { lastModified: 1234 });
	var reads = { n: 0 };
	var slice = f.slice.bind(f);
	f.slice = function (a, b) { reads.n++; return slice(a, b); };
	return { file: f, reads: reads };
}

var REGION = { x: 5, y: 3, width: 50, height: 40 };

test("by default a repeat read reuses cached tiles and returns the same pixels", async function () {
	var c = countingFile();
	var ecw = await openEcw(c.file);
	var before = c.reads.n;
	var a = await ecw.readRegion(REGION);
	var firstReads = c.reads.n - before;
	before = c.reads.n;
	var b = await ecw.readRegion(REGION);
	assert.ok(firstReads > 0);
	assert.equal(c.reads.n - before, 0, "no block reads on the repeat");
	assert.deepEqual(Array.from(b.data), Array.from(a.data));
	var plain = await (await openEcw(new Blob([BYTES]), { cache: false })).readRegion(REGION);
	assert.deepEqual(Array.from(a.data), Array.from(plain.data));
});

test("cache: false reads blocks every time", async function () {
	var c = countingFile();
	var ecw = await openEcw(c.file, { cache: false });
	await ecw.readRegion(REGION);
	var before = c.reads.n;
	await ecw.readRegion(REGION);
	assert.ok(c.reads.n - before > 0);
});

test("the OPFS tier serves a fresh reader of the same file", async function () {
	var root = createFakeRoot();
	var first = await openEcw(countingFile().file, { cache: { opfs: { root: root } } });
	var a = await first.readRegion(REGION);
	assert.equal((await blockCacheUsage({ root: root })).length, 1);
	var c = countingFile();
	var second = await openEcw(c.file, { cache: { opfs: { root: root } } });
	var before = c.reads.n;
	var b = await second.readRegion(REGION);
	assert.equal(c.reads.n - before, 0, "every tile came from OPFS");
	assert.deepEqual(Array.from(b.data), Array.from(a.data));
	assert.ok(second.cacheStats().opfsHits > 0);
});

test("an invalid cache option rejects INVALID_ARGUMENT", async function () {
	await assert.rejects(openEcw(new Blob([BYTES]), { cache: "yes" }), { code: "INVALID_ARGUMENT" });
});

test("resample average gives the same pixels with or without the cache", async function () {
	var opts = { x: 1, y: 2, width: 61, height: 45, outWidth: 40, outHeight: 30, resample: "average" };
	var cached = await (await openEcw(new Blob([BYTES]))).readRegion(opts);
	var plain = await (await openEcw(new Blob([BYTES]), { cache: false })).readRegion(opts);
	assert.deepEqual(Array.from(cached.data), Array.from(plain.data));
	// and a cached repeat
	var ecw = await openEcw(new Blob([BYTES]));
	await ecw.readRegion(opts);
	assert.deepEqual(Array.from((await ecw.readRegion(opts)).data), Array.from(plain.data));
});
