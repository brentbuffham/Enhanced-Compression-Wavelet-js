// test/dev/probeLib.test.js
//==========================================================
// Pure helpers behind the reverse-engineering probes.
// Run with: node --test test/dev/probeLib.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatHexRows, shannonEntropy, histogramTop, parseNumberArg } from "../../_dev/ecw-decode/probeLib.mjs";

function ramp(n, start) { return Uint8Array.from({ length: n }, function (_, i) { return (start || 0) + i; }); }

test("entropy of constant bytes is 0", function () {
	assert.equal(shannonEntropy(new Uint8Array(64)), 0);
});

test("entropy of all 256 values once is 8", function () {
	assert.equal(shannonEntropy(ramp(256)), 8);
});

test("entropy of empty input is 0", function () {
	assert.equal(shannonEntropy(new Uint8Array(0)), 0);
});

test("histogramTop orders by count then value", function () {
	assert.deepEqual(histogramTop(Uint8Array.from([5, 1, 5, 1, 9]), 2), [{ value: 1, count: 2 }, { value: 5, count: 2 }]);
});

test("formatHexRows labels the row an annotation starts in", function () {
	var rows = formatHexRows(ramp(20, 0x41), 0x100, [{ offset: 0x112, length: 2, label: "w" }]);
	assert.equal(rows.length, 2);
	assert.match(rows[0], /^0x00000100: 41 42/);
	assert.doesNotMatch(rows[0], /;/);
	assert.match(rows[1], /; w$/);
});

test("formatHexRows shows printable ASCII and dots", function () {
	var rows = formatHexRows(Uint8Array.from([0x47, 0x00, 0x41]), 0, []);
	assert.match(rows[0], /  G\.A$/);
});

test("parseNumberArg accepts decimal and 0x hex", function () {
	assert.equal(parseNumberArg("0x59"), 0x59);
	assert.equal(parseNumberArg("512"), 512);
	assert.throws(function () { parseNumberArg("zz"); });
});
