// test/workers/poolProtocol.test.js
//==========================================================
// Message handling of a decode-pool worker, driven in process
// (no threads): open, rows (bands of output rows), progress,
// abort and errors.
// Run with: node --test test/workers/poolProtocol.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPoolWorkerHandler } from "../../src/workers/poolProtocol.js";
import { openEcw } from "../../src/EcwReader.js";
import { buildCodedFile } from "../helpers/buildCodedFile.js";

function file() {
	return new Blob([buildCodedFile({ width: 64, height: 48, levelCount: 3, coeff: function (r, b, sb, x, y) {
		return sb === "LL" ? [60 + 5 * x + 2 * y, 3, -2][b] : ((x + y + r + b) % 5) - 2;
	} }).bytes]);
}

function harness() {
	var messages = [];
	var handle = createPoolWorkerHandler(function (msg, transfer) { messages.push({ msg: msg, transfer: transfer || [] }); });
	return {
		messages: messages,
		handle: handle,
		last: function (id) { return messages.filter(function (m) { return m.msg.id === id && m.msg.progress === undefined; }).pop(); }
	};
}

var OPTS = { x: 2, y: 3, width: 60, height: 44, outWidth: 30, outHeight: 22, resample: "average", transparentBelow: 40 };

test("open, then rows answers a band's RGBA, transferred, equal to the reader's own rows", async function () {
	var h = harness();
	var blob = file();
	await h.handle({ id: 1, type: "open", blob: blob, cache: false });
	assert.deepEqual(h.last(1).msg, { id: 1, result: true });
	await h.handle({ id: 2, type: "rows", opts: OPTS, oy0: 5, oy1: 17 });
	var res = h.last(2);
	assert.ok(res.msg.data instanceof ArrayBuffer);
	assert.deepEqual(res.transfer, [res.msg.data]);
	var direct = await openEcw(blob, { cache: false, threads: 1 });
	var want = await direct._decodeRows(direct._plan(OPTS), 5, 17, function () {});
	assert.deepEqual(Array.from(new Uint8ClampedArray(res.msg.data)), Array.from(want.data));
	assert.deepEqual(res.msg.badBlocks, []);
	var progress = h.messages.filter(function (m) { return m.msg.id === 2 && m.msg.progress !== undefined; });
	assert.ok(progress.length >= 1);
	progress.forEach(function (m) { assert.ok(m.msg.progress >= 0 && m.msg.progress <= 1); });
});

test("abort ends a running band with ABORTED", async function () {
	var h = harness();
	await h.handle({ id: 1, type: "open", blob: file() });
	var job = h.handle({ id: 2, type: "rows", opts: { x: 0, y: 0, width: 64, height: 48 }, oy0: 0, oy1: 48 });
	await h.handle({ type: "abort", id: 2 });
	await job;
	assert.equal(h.last(2).msg.error.code, "ABORTED");
});

test("rows before open, unknown types and bad options answer errors with codes", async function () {
	var h = harness();
	await h.handle({ id: 1, type: "rows", opts: OPTS, oy0: 0, oy1: 1 });
	assert.equal(h.last(1).msg.error.code, "INVALID_ARGUMENT");
	await h.handle({ id: 2, type: "explode" });
	assert.equal(h.last(2).msg.error.code, "INVALID_ARGUMENT");
	await h.handle({ id: 3, type: "open", blob: new Blob([new Uint8Array(200)]) });
	assert.equal(h.last(3).msg.error.code, "NOT_ECW");
	await h.handle({ id: 4, type: "open", blob: file() });
	await h.handle({ id: 5, type: "rows", opts: { x: 0, y: 0, width: 999, height: 1 }, oy0: 0, oy1: 1 });
	assert.equal(h.last(5).msg.error.code, "INVALID_ARGUMENT");
	// aborting a job that isn't running is harmless
	await h.handle({ type: "abort", id: 99 });
	await h.handle({ type: "close" });
	await h.handle({ id: 7, type: "rows", opts: OPTS, oy0: 0, oy1: 1 });
	assert.equal(h.last(7).msg.error.code, "INVALID_ARGUMENT");
});
