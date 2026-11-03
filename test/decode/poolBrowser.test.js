// test/decode/poolBrowser.test.js
//==========================================================
// The decode pool's browser path, run in Node: a stand-in global
// Worker (backed by worker_threads) takes the place of a module
// Worker. Also the Node helpers: worker flags and the core count
// without navigator.
// Run with: node --test test/decode/poolBrowser.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker as ThreadWorker } from "node:worker_threads";
import { createDecodePool, defaultThreads, nodeWorkerOptions } from "../../src/decode/pool.js";
import { openEcw } from "../../src/EcwReader.js";
import { buildCodedFile } from "../helpers/buildCodedFile.js";

function file() {
	return new Blob([buildCodedFile({ width: 64, height: 48, levelCount: 3, coeff: function (r, b, sb, x, y) {
		return sb === "LL" ? [60 + 5 * x + 2 * y, 3, -2][b] : ((x + y + r + b) % 5) - 2;
	} }).bytes]);
}
var OPTS = { x: 0, y: 0, width: 64, height: 48 };

// A browser-style Worker over worker_threads; remembers every instance
var made = [];
function FakeWorker(url, options) {
	assert.deepEqual(options, { type: "module" });
	assert.match(String(url), /\/src\/workers\/decodePoolWorker\.js$/);
	var self = this;
	this._w = new ThreadWorker(url);
	this._w.on("message", function (data) { if (self.onmessage) self.onmessage({ data: data }); });
	made.push(this);
}
FakeWorker.prototype.postMessage = function (m, t) { this._w.postMessage(m, t); };
FakeWorker.prototype.terminate = function () { this.terminated = true; this._w.terminate(); };

async function withFakeWorker(fn) {
	made = [];
	globalThis.Worker = FakeWorker;
	try { await fn(); } finally { delete globalThis.Worker; }
}

test("browser path: module Workers from the pool's own URL decode the same bytes", async function () {
	await withFakeWorker(async function () {
		var blob = file();
		var pool = await createDecodePool(2, blob, false);
		assert.equal(made.length, 2);
		var direct = await openEcw(blob, { cache: false, threads: 1 });
		var band = await pool.rows(1, { opts: OPTS, oy0: 10, oy1: 30 });
		assert.deepEqual(Array.from(band.data), Array.from((await direct._decodeRows(direct._plan(OPTS), 10, 30, function () {})).data));
		assert.ok(band.data.length > 0);
		pool.close();
		assert.ok(made.every(function (w) { return w.terminated; }));
	});
});

test("browser path: a worker error or unreadable reply breaks the pool with WORKER_FAILED", async function () {
	await withFakeWorker(async function () {
		var pool = await createDecodePool(1, file(), false);
		var prevented = false;
		made[0].onerror({ message: "script failed", preventDefault: function () { prevented = true; } });
		assert.ok(prevented, "the error is handled, not reported again");
		assert.equal(pool.broken, true);
		await assert.rejects(pool.rows(0, { opts: OPTS, oy0: 0, oy1: 1 }), function (err) { return err.code === "WORKER_FAILED" && /script failed/.test(err.message); });
		pool.close();
		var other = await createDecodePool(1, file(), false);
		made[1].onmessageerror();
		await assert.rejects(other.rows(0, { opts: OPTS, oy0: 0, oy1: 1 }), function (err) { return err.code === "WORKER_FAILED" && /could not be read/.test(err.message); });
		// an error event without details still breaks the pool
		var third = await createDecodePool(1, file(), false);
		made[2].onerror(null);
		assert.equal(third.broken, true);
		other.close();
		third.close();
	});
});

test("a task that can't be posted fails alone and the worker stays free", async function () {
	await withFakeWorker(async function () {
		var pool = await createDecodePool(1, file(), false);
		await assert.rejects(pool.rows(0, { opts: { x: 0, y: 0, width: 64, height: 48, notCloneable: function () {} }, oy0: 0, oy1: 2 }), { code: "WORKER_FAILED" });
		assert.equal(pool.broken, false);
		assert.equal((await pool.rows(0, { opts: OPTS, oy0: 0, oy1: 2 })).data.length, 64 * 2 * 4);
		pool.close();
	});
});

test("nodeWorkerOptions drops --input-type and nothing else", function () {
	assert.equal(nodeWorkerOptions(["--test", "--enable-source-maps"]), undefined);
	assert.deepEqual(nodeWorkerOptions(["--input-type=module", "--trace-warnings"]), { execArgv: ["--trace-warnings"] });
	assert.deepEqual(nodeWorkerOptions(["--input-type", "module", "--trace-warnings"]), { execArgv: ["--trace-warnings"] });
});

test("defaultThreads falls back to the OS core count without navigator", async function () {
	var desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
	try {
		var n = await defaultThreads();
		assert.ok(Number.isInteger(n) && n >= 1 && n <= 16);
	} finally {
		Object.defineProperty(globalThis, "navigator", desc);
	}
});
