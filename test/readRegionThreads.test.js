// test/readRegionThreads.test.js
//==========================================================
// readRegion and readRegionToScratch with the worker pool
// (threads: 2, real worker_threads) give byte for byte what
// one thread gives, for every option that changes pixels.
// Run with: node --test test/readRegionThreads.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openEcw } from "../src/EcwReader.js";
import { buildCodedFile } from "./helpers/buildCodedFile.js";
import { createFakeRoot } from "./helpers/fakeOpfs.js";
import { setTimeout as wait } from "node:timers/promises";

function file() {
	return new Blob([buildCodedFile({ width: 64, height: 48, levelCount: 3, coeff: function (r, b, sb, x, y) {
		return sb === "LL" ? [60 + 5 * x + 2 * y, 3, -2][b] : ((x * y + r + b) % 7) - 3;
	} }).bytes]);
}

var CASES = [
	{ x: 0, y: 0, width: 64, height: 48 },
	{ x: 3, y: 5, width: 57, height: 41, outWidth: 19, outHeight: 13, resample: "average" },
	{ x: 1, y: 2, width: 60, height: 44, outWidth: 45, outHeight: 33 },
	{ x: 0, y: 0, width: 64, height: 48, transparentBelow: 70, transparentColor: { color: [90, 80, 70], below: 10 } },
	{ x: 0, y: 0, width: 64, height: 48, stretch: { min: [50, 50, 50], max: [200, 200, 200] },
		clipPolygon: [[[1005, 4990], [1025, 4990], [1020, 4980], [1005, 4980]]] }
];

test("threads: 2 reads equal threads: 1 reads", async function () {
	var blob = file();
	var one = await openEcw(blob, { threads: 1 });
	var two = await openEcw(blob, { threads: 2 });
	for (var c of CASES) {
		var a = await one.readRegion(c);
		var b = await two.readRegion(c);
		assert.deepEqual(Array.from(b.data), Array.from(a.data), JSON.stringify(c));
		assert.deepEqual([b.width, b.height, b.level, b.bounds], [a.width, a.height, a.level, a.bounds]);
	}
	assert.ok(two._poolStart, "the pool started");
	await two.close();
	await one.close();
});

test("threads: 2 scratch strips equal threads: 1", async function () {
	var blob = file();
	async function strips(threads) {
		var ecw = await openEcw(blob, { threads: threads });
		var out = await ecw.readRegionToScratch({ x: 0, y: 0, width: 64, height: 48, stripBytes: 64 * 4 * 10, scratch: { root: createFakeRoot() } });
		var reader = await out.openReader();
		var bytes = Array.from(reader.slice(0, out.byteLength));
		reader.close();
		await ecw.close();
		return bytes;
	}
	assert.deepEqual(await strips(2), await strips(1));
});

test("progress from the bands climbs to 1", async function () {
	var ecw = await openEcw(file(), { threads: 2 });
	var seen = [];
	await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, onProgress: function (f) { seen.push(f); } });
	assert.equal(seen[seen.length - 1], 1);
	seen.forEach(function (f, i) { assert.ok(i === 0 || f >= seen[i - 1], "progress went back at " + i); });
	await ecw.close();
});

test("abort rejects a pooled read with ABORTED", async function () {
	var ecw = await openEcw(file(), { threads: 2 });
	var ctl = new AbortController();
	var read = ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, signal: ctl.signal });
	ctl.abort();
	await assert.rejects(read, { code: "ABORTED" });
	await ecw.close();
});

test("threads must be an integer of 0 or more", async function () {
	for (var bad of [-1, 1.5, "2", null]) {
		await assert.rejects(openEcw(file(), { threads: bad }), { code: "INVALID_ARGUMENT" }, String(bad));
	}
});

test("automatic threads leave small reads on this thread", async function () {
	var ecw = await openEcw(file());
	await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48 });
	assert.equal(ecw._poolStart, null);
	await ecw.close();
});

test("when workers can't start, reads fall back to this thread", async function () {
	var blob = file();
	var ecw = await openEcw(blob, { threads: 2 });
	ecw._poolUrl = new URL("./helpers/workers/throwsOnStart.js", import.meta.url);
	var img = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48 });
	var want = await (await openEcw(blob, { threads: 1 })).readRegion({ x: 0, y: 0, width: 64, height: 48 });
	assert.deepEqual(Array.from(img.data), Array.from(want.data));
	assert.equal(ecw._poolFailed, true);
	await ecw.close();
});

test("a worker dying mid-read fails that read; later reads use this thread", async function () {
	var ecw = await openEcw(file(), { threads: 2 });
	ecw._poolUrl = new URL("./helpers/workers/diesOnTask.js", import.meta.url);
	await assert.rejects(ecw.readRegion({ x: 0, y: 0, width: 64, height: 48 }), { code: "WORKER_FAILED" });
	var img = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48 });
	assert.equal(img.data.length, 64 * 48 * 4);
	await ecw.close();
});

test("close ends the pool; a read after close is rejected", async function () {
	var ecw = await openEcw(file(), { threads: 2 });
	await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48 });
	await ecw.close();
	await assert.rejects(ecw.readRegion({ x: 0, y: 0, width: 64, height: 48 }), { code: "INVALID_ARGUMENT" });
});

test("automatic threads: at most 4 workers, and none when the OPFS cache is on", async function () {
	var ecw = await openEcw(file());
	ecw._autoMinPixels = 1;
	await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48 });
	var pool = await ecw._poolStart;
	assert.ok(pool === null || (pool.size >= 2 && pool.size <= 4), "pool of " + (pool && pool.size));
	await ecw.close();
	var opfs = await openEcw(file(), { cache: { opfs: { root: createFakeRoot() } } });
	opfs._autoMinPixels = 1;
	await opfs.readRegion({ x: 0, y: 0, width: 64, height: 48 });
	assert.equal(opfs._poolStart, null);
	await opfs.close();
	var pinned = await openEcw(file(), { threads: 2, cache: { opfs: { root: createFakeRoot() } } });
	await pinned.readRegion({ x: 0, y: 0, width: 64, height: 48 });
	assert.equal((await pinned._poolStart).size, 2, "explicit threads use the pool even with OPFS");
	await pinned.close();
});

test("an idle pool closes its workers and starts again on the next read", async function () {
	var ecw = await openEcw(file(), { threads: 2 });
	ecw._poolIdleMs = 30;
	var first = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48 });
	var pool = await ecw._poolStart;
	await wait(120);
	assert.equal(ecw._poolStart, null);
	await assert.rejects(pool.rows(0, { opts: { x: 0, y: 0, width: 64, height: 48 }, oy0: 0, oy1: 1 }), { code: "ABORTED" });
	var again = await ecw.readRegion({ x: 0, y: 0, width: 64, height: 48 });
	assert.deepEqual(Array.from(again.data), Array.from(first.data));
	assert.ok(ecw._poolStart);
	await ecw.close();
});

test("aborting while bands run stops every worker", async function () {
	var ecw = await openEcw(file(), { threads: 2 });
	ecw._poolUrl = new URL("./helpers/workers/waitsForAbort.js", import.meta.url);
	var ctl = new AbortController();
	var read = ecw.readRegion({ x: 0, y: 0, width: 64, height: 48, signal: ctl.signal });
	await ecw._poolStart;
	await wait(20);
	ctl.abort();
	await assert.rejects(read, { code: "ABORTED" });
	await ecw.close();
});

test("automatic mode never waits for workers: the first big read runs here while the pool starts", async function () {
	var ecw = await openEcw(file());
	ecw._autoMinPixels = 1;
	var labels = [];
	var opts = { x: 0, y: 0, width: 64, height: 48, onProgress: function (f, label) { labels.push(label); } };
	var first = await ecw.readRegion(opts);
	assert.ok(!labels.some(function (l) { return /workers/.test(l); }), "the first read ran on this thread");
	var pool = await ecw._poolStart;
	if (pool) {
		labels = [];
		var second = await ecw.readRegion(opts);
		assert.ok(labels.some(function (l) { return /decoding in \d+ workers/.test(l); }), "the next read used the pool");
		assert.deepEqual(Array.from(second.data), Array.from(first.data));
	}
	await ecw.close();
});
