// test/workers/workerProtocol.test.js
//==========================================================
// Worker message protocol, driven directly (no real Worker):
// in  { id, type: "open" | "readRegion" | "readRegionToScratch" | "abort" | "close", payload }
// out { id, type: "progress" | "result" | "error", ... }
// Run with: node --test test/workers/workerProtocol.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWorkerHandler } from "../../src/workers/workerProtocol.js";
import { openEcw } from "../../src/EcwReader.js";
import { buildCodedFile } from "../helpers/buildCodedFile.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";

function file() {
	return new Blob([buildCodedFile({ width: 64, height: 48, levelCount: 3, coeff: function (r, b, sb, x, y) {
		return sb === "LL" ? [60 + 5 * x + 2 * y, 3, -2][b] : ((x + y + r + b) % 5) - 2;
	} }).bytes]);
}

// A handler whose posted messages are collected; send() resolves with the job's final message
function harness() {
	var messages = [];
	var handle = createWorkerHandler(function (msg, transfer) { messages.push({ msg: msg, transfer: transfer || [] }); });
	var nextId = 0;
	return {
		messages: messages,
		send: async function (type, payload) {
			var id = ++nextId;
			await handle({ id: id, type: type, payload: payload });
			return messages.filter(function (m) { return m.msg.id === id && m.msg.type !== "progress"; }).pop();
		},
		handle: handle
	};
}

test("open answers with the reader's info", async function () {
	var h = harness();
	var res = await h.send("open", { blob: file() });
	assert.equal(res.msg.type, "result");
	assert.equal(res.msg.result.width, 64);
	assert.equal(res.msg.result.levels.length, 4);
});

test("readRegion answers with the same pixels as a direct call, buffer transferred", async function () {
	var h = harness();
	var blob = file();
	await h.send("open", { blob: blob });
	var opts = { x: 2, y: 3, width: 40, height: 30, outWidth: 17, outHeight: 11, resample: "average" };
	var res = await h.send("readRegion", opts);
	var direct = await (await openEcw(blob)).readRegion(opts);
	assert.equal(res.msg.type, "result");
	assert.deepEqual(res.msg.result.bounds, direct.bounds);
	assert.equal(res.msg.result.level, direct.level);
	assert.deepEqual(Array.from(res.msg.result.data), Array.from(direct.data));
	assert.deepEqual(res.transfer, [res.msg.result.data.buffer]);
	assert.ok(h.messages.some(function (m) { return m.msg.type === "progress" && m.msg.fraction === 1; }));
});

test("readRegionToScratch answers with the scratch description", async function () {
	var h = harness();
	await h.send("open", { blob: file() });
	var res = await h.send("readRegionToScratch", { x: 0, y: 0, width: 64, height: 48, scratch: { root: createFakeRoot() } });
	assert.equal(res.msg.type, "result");
	assert.match(res.msg.result.scratchId, /^region-/);
	assert.equal(res.msg.result.byteLength, 64 * 48 * 4);
	assert.equal(typeof res.msg.result.openReader, "undefined", "functions do not cross postMessage");
});

test("errors carry the EcwError code", async function () {
	var h = harness();
	var early = await h.send("readRegion", { x: 0, y: 0, width: 1, height: 1 });
	assert.equal(early.msg.type, "error");
	assert.equal(early.msg.code, "INVALID_ARGUMENT");
	await h.send("open", { blob: file() });
	var bad = await h.send("readRegion", { x: 0, y: 0, width: 999, height: 1 });
	assert.equal(bad.msg.code, "INVALID_ARGUMENT");
	var unknown = await h.send("explode", {});
	assert.equal(unknown.msg.code, "INVALID_ARGUMENT");
	var notEcw = await h.send("open", { blob: new Blob([new Uint8Array(200)]) });
	assert.equal(notEcw.msg.code, "NOT_ECW");
});

test("abort cancels a running job with ABORTED", async function () {
	var h = harness();
	await h.send("open", { blob: file() });
	var job = h.handle({ id: 50, type: "readRegion", payload: { x: 0, y: 0, width: 64, height: 48 } });
	await h.handle({ id: 51, type: "abort", payload: { id: 50 } });
	await job;
	var res = h.messages.filter(function (m) { return m.msg.id === 50 && m.msg.type !== "progress"; }).pop();
	assert.equal(res.msg.type, "error");
	assert.equal(res.msg.code, "ABORTED");
});

test("close answers and later reads report no open file", async function () {
	var h = harness();
	await h.send("open", { blob: file() });
	assert.equal((await h.send("close", {})).msg.type, "result");
	assert.equal((await h.send("readRegion", { x: 0, y: 0, width: 1, height: 1 })).msg.code, "INVALID_ARGUMENT");
});

test("the worker entry imports cleanly outside a Worker and is exported as ecw-js/worker", async function () {
	await import("../../src/workers/ecwDecodeWorker.js");
	var pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.exports["./worker"], "./src/workers/ecwDecodeWorker.js");
});
