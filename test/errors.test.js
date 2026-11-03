// test/errors.test.js
//==========================================================
// EcwError shape and the frozen code list.
// Run with: node --test test/errors.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EcwError, ERROR_CODES } from "../src/errors.js";

test("EcwError carries code and offset", function () {
	var e = new EcwError(ERROR_CODES.TRUNCATED, "need more bytes", 0x59);
	assert.ok(e instanceof Error);
	assert.equal(e.name, "EcwError");
	assert.equal(e.code, "TRUNCATED");
	assert.equal(e.offset, 0x59);
	assert.match(e.message, /\(at 0x59\)$/);
});

test("EcwError without offset leaves message alone", function () {
	var e = new EcwError(ERROR_CODES.ABORTED, "stopped");
	assert.equal(e.offset, undefined);
	assert.equal(e.message, "stopped");
});

test("ERROR_CODES is frozen and lists every code", function () {
	assert.ok(Object.isFrozen(ERROR_CODES));
	assert.deepEqual(Object.keys(ERROR_CODES).sort(), ["ABORTED", "BAD_BLOCK", "BAD_BLOCK_INDEX", "BAD_LEVEL_TABLE", "INVALID_ARGUMENT", "NOT_ECW",
		"NOT_IMPLEMENTED", "OUTPUT_TOO_LARGE", "TRUNCATED", "UNSUPPORTED_MODE", "UNSUPPORTED_VERSION", "WORKER_FAILED"]);
	Object.keys(ERROR_CODES).forEach(function (k) { assert.equal(ERROR_CODES[k], k); });
});

test("errorToData / errorFromData round-trip without repeating the offset", async function () {
	var { errorToData, errorFromData } = await import("../src/errors.js");
	var e = new EcwError(ERROR_CODES.UNSUPPORTED_MODE, "stream mode 9 isn't decoded", 0x40);
	e.mode = 9;
	e.block = { number: 3, level: 1, row: 0, col: 3, offset: 0x30 };
	var d = errorToData(e);
	assert.deepEqual(d, { code: "UNSUPPORTED_MODE", message: "stream mode 9 isn't decoded (at 0x40)", offset: 0x40, block: e.block, mode: 9 });
	var back = errorFromData(JSON.parse(JSON.stringify(d)));
	assert.ok(back instanceof EcwError);
	assert.equal(back.message, e.message);
	assert.equal(back.offset, 0x40);
	assert.equal(back.mode, 9);
	assert.deepEqual(back.block, e.block);
	assert.deepEqual(errorToData(new Error("plain")), { code: "ERROR", message: "plain" });
	assert.equal(errorFromData({ message: "x" }, "WORKER_FAILED").code, "WORKER_FAILED");
});
