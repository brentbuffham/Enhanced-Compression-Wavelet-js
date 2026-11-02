// test/decode/pool.test.js
//==========================================================
// The decode pool with real Node worker_threads: start-up,
// pinned bands, fallback when workers can't start or open,
// a worker dying mid-task, abort and close.
// Run with: node --test test/decode/pool.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecodePool, defaultThreads } from "../../src/decode/pool.js";
import { openEcw } from "../../src/EcwReader.js";
import { buildCodedFile } from "../helpers/buildCodedFile.js";

function file() {
	return new Blob([buildCodedFile({ width: 64, height: 48, levelCount: 3, coeff: function (r, b, sb, x, y) {
		return sb === "LL" ? [60 + 5 * x + 2 * y, 3, -2][b] : ((x + y + r + b) % 5) - 2;
	} }).bytes]);
}
var OPTS = { x: 0, y: 0, width: 64, height: 48 };

test("defaultThreads is one fewer than the cores, between 1 and 16", async function () {
	var n = await defaultThreads();
	assert.ok(Number.isInteger(n) && n >= 1 && n <= 16);
});

test("a pool of 2 decodes bands on its workers, the same bytes as this thread", async function () {
	var blob = file();
	var pool = await createDecodePool(2, blob, false);
	assert.equal(pool.size, 2);
	var direct = await openEcw(blob, { cache: false, threads: 1 });
	var plan = direct._plan(OPTS);
	var fractions = [];
	var bands = await Promise.all([
		pool.rows(0, { opts: OPTS, oy0: 0, oy1: 20 }, function (f) { fractions.push(f); }),
		pool.rows(1, { opts: OPTS, oy0: 20, oy1: 48 })
	]);
	assert.deepEqual(Array.from(bands[0]), Array.from(await direct._decodeRows(plan, 0, 20, function () {})));
	assert.deepEqual(Array.from(bands[1]), Array.from(await direct._decodeRows(plan, 20, 48, function () {})));
	assert.ok(fractions.length >= 1);
	pool.close();
	pool.close();
	await assert.rejects(pool.rows(0, { opts: OPTS, oy0: 0, oy1: 1 }), { code: "ABORTED" });
});

test("a worker that can't start, or can't open the file, gives no pool", async function () {
	assert.equal(await createDecodePool(2, file(), false, new URL("../helpers/workers/throwsOnStart.js", import.meta.url)), null);
	assert.equal(await createDecodePool(2, new Blob([new Uint8Array(300)]), false), null);
});

test("a worker that dies mid-task fails its task with WORKER_FAILED and marks the pool broken", async function () {
	var pool = await createDecodePool(1, file(), false, new URL("../helpers/workers/diesOnTask.js", import.meta.url));
	await assert.rejects(pool.rows(0, { opts: OPTS, oy0: 0, oy1: 48 }), { code: "WORKER_FAILED" });
	assert.equal(pool.broken, true);
	await assert.rejects(pool.rows(0, { opts: OPTS, oy0: 0, oy1: 1 }), { code: "WORKER_FAILED" });
	pool.close();
});

test("abort: a queued band rejects at once, a running band is told to stop", async function () {
	var pool = await createDecodePool(1, file(), false, new URL("../helpers/workers/waitsForAbort.js", import.meta.url));
	var ctl = new AbortController();
	var running = pool.rows(0, { opts: OPTS, oy0: 0, oy1: 48 }, null, ctl.signal);
	var queued = pool.rows(0, { opts: OPTS, oy0: 0, oy1: 48 }, null, ctl.signal);
	ctl.abort();
	await assert.rejects(queued, { code: "ABORTED" });
	await assert.rejects(running, { code: "ABORTED" });
	await assert.rejects(pool.rows(0, { opts: OPTS, oy0: 0, oy1: 1 }, null, ctl.signal), { code: "ABORTED" });
	// the worker is free again afterwards
	assert.equal((await pool.rows(0, { opts: OPTS, oy0: 0, oy1: 2 })).length, 64 * 2 * 4);
	pool.close();
});
