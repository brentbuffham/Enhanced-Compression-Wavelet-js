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
		"NOT_IMPLEMENTED", "OUTPUT_TOO_LARGE", "TRUNCATED", "UNSUPPORTED_VERSION"]);
	Object.keys(ERROR_CODES).forEach(function (k) { assert.equal(ERROR_CODES[k], k); });
});
