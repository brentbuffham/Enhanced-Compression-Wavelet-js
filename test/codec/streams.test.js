// test/codec/streams.test.js
//==========================================================
// Stream decoders: mode 6 (run-length words), mode 2 (Huffman
// tree + LSB-first codes), mode 3 (range-coded bytes), mode 5 (empty).
// Run with: node --test test/codec/streams.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeMode6, decodeMode2, decodeStream } from "../../src/codec/streams.js";
import { encodeMode2 } from "../helpers/encodeMode2.js";
import { decodeMode3 } from "../../src/codec/rangeCoded.js";
import { encodeMode3 } from "../helpers/encodeMode3.js";
import { EcwError } from "../../src/errors.js";

function words(list) {
	var out = new Uint8Array(list.length * 2);
	list.forEach(function (w, i) { out[i * 2] = w & 0xFF; out[i * 2 + 1] = w >> 8; });
	return out;
}
function plus(m) { return { kind: "+", m: m }; }
function minus(m) { return { kind: "-", m: m }; }
function zeros(m) { return { kind: "z", m: m }; }

test("mode 6: +value, -value and zero-run words", function () {
	assert.deepEqual(Array.from(decodeMode6(words([0x8003, 0x0005, 0x4002]), 5)), [0, 0, 0, 5, -2]);
});

test("mode 6: 14-bit magnitudes", function () {
	assert.deepEqual(Array.from(decodeMode6(words([0x3FFF, 0x7FFF]), 2)), [16383, -16383]);
});

test("mode 6: odd byte length throws BAD_BLOCK", function () {
	assert.throws(function () { decodeMode6(Uint8Array.from([1, 0, 2]), 2); }, { code: "BAD_BLOCK" });
});

test("mode 6: value count that disagrees with the extent throws BAD_BLOCK", function () {
	assert.throws(function () { decodeMode6(words([0x8004]), 3); }, { code: "BAD_BLOCK" });
	assert.throws(function () { decodeMode6(words([0x8002]), 3); }, { code: "BAD_BLOCK" });
});

test("mode 6: tag 11 throws BAD_BLOCK", function () {
	assert.throws(function () { decodeMode6(words([0xC001]), 1); }, { code: "BAD_BLOCK" });
});

test("mode 2: round-trips short-token symbols", function () {
	var seq = [zeros(10), plus(3), minus(1), zeros(2), plus(3), plus(15), minus(15)];
	var out = decodeMode2(encodeMode2(seq), 17);
	assert.deepEqual(Array.from(out), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, -1, 0, 0, 3, 15, -15]);
});

test("mode 2: long 0x80 word leaves", function () {
	var seq = [zeros(1000), plus(300), minus(2000)];
	var out = decodeMode2(encodeMode2(seq), 1002);
	assert.equal(out[999], 0);
	assert.equal(out[1000], 300);
	assert.equal(out[1001], -2000);
	assert.deepEqual(Array.from(decodeMode2(encodeMode2([plus(1), zeros(2)], { forceLong: true }), 3)), [1, 0, 0]);
});

test("mode 2: a single-leaf tree repeats its symbol", function () {
	assert.deepEqual(Array.from(decodeMode2(encodeMode2([zeros(4)]), 8)), [0, 0, 0, 0, 0, 0, 0, 0]);
	assert.deepEqual(Array.from(decodeMode2(encodeMode2([plus(2)]), 3)), [2, 2, 2]);
});

test("mode 2: tree that does not close at N nodes throws BAD_BLOCK", function () {
	var bytes = encodeMode2([plus(1), minus(1), zeros(3)]);
	bytes[0] = 7;
	assert.throws(function () { decodeMode2(bytes, 5); }, { code: "BAD_BLOCK" });
});

test("mode 2: data running out throws BAD_BLOCK", function () {
	var bytes = encodeMode2([plus(1), minus(1), zeros(3), plus(1), minus(1)]);
	assert.throws(function () { decodeMode2(bytes.subarray(0, bytes.length - 2), 4000); }, { code: "BAD_BLOCK" });
});

test("mode 2: a zero run overshooting the extent throws BAD_BLOCK", function () {
	assert.throws(function () { decodeMode2(encodeMode2([plus(1), zeros(10)]), 5); }, { code: "BAD_BLOCK" });
});

test("decodeStream: mode 5 is all zeros, others dispatch", function () {
	assert.deepEqual(Array.from(decodeStream({ mode: 5, bytes: new Uint8Array(0) }, 4)), [0, 0, 0, 0]);
	assert.deepEqual(Array.from(decodeStream({ mode: 6, bytes: words([0x0007]) }, 1)), [7]);
	assert.deepEqual(Array.from(decodeStream({ mode: 2, bytes: encodeMode2([minus(4)]) }, 1)), [-4]);
});

test("mode 2: deep trees (300 distinct symbols) decode", function () {
	var seq = [];
	for (var i = 1; i <= 300; i++) seq.push(plus(i));
	var out = decodeMode2(encodeMode2(seq), 300);
	assert.equal(out[0], 1);
	assert.equal(out[299], 300);
});

test("decodeStream rejects a mode it does not decode with UNSUPPORTED_MODE", function () {
	assert.throws(function () { decodeStream({ mode: 9, bytes: new Uint8Array(4) }, 1); },
		function (err) { return err instanceof EcwError && err.code === "UNSUPPORTED_MODE" && err.mode === 9 && /mode 9/.test(err.message); });
});

// Mode 3: range-coded little-endian int16 values under an adaptive byte model.
// The pinned bytes start like the raw values (lead 00, then 01 00, ff ...) because the
// model starts nearly flat; the last 3 bytes are the payload length.
var MODE3_VECTOR = [0x00, 0x01, 0x00, 0xff, 0x0e, 0x64, 0xad, 0x9c, 0x32, 0x87, 0x30, 0xd1, 0xc6, 0x99, 0x21, 0xe1, 0x00, 0x00, 0x13];

test("mode 3: pinned vector decodes to its values", function () {
	assert.deepEqual(Array.from(decodeMode3(Uint8Array.from(MODE3_VECTOR), 7)), [1, -1, 300, -300, 0, 32767, -32768]);
	assert.deepEqual(Array.from(encodeMode3([1, -1, 300, -300, 0, 32767, -32768])), MODE3_VECTOR);
});

function seeded(n, seed, spread) {
	var out = [], x = seed;
	for (var i = 0; i < n; i++) { x = (x * 1103515245 + 12345) % 2147483648; var r = x / 2147483648; out.push(r < 0.2 ? 0 : Math.round((r - 0.6) * spread) | 0); }
	return out;
}

test("mode 3: round trips through every model rebuild (64x4 and 64x64 blocks)", function () {
	for (var c of [[256, 1, 120], [256, 7, 3], [4096, 3, 400], [4096, 5, 60000]]) {
		var values = seeded(c[0], c[1], c[2]).map(function (v) { return Math.max(-32768, Math.min(32767, v)); });
		assert.deepEqual(Array.from(decodeMode3(encodeMode3(values), values.length)), values);
	}
});

test("mode 3: decodeStream dispatches mode 3", function () {
	assert.deepEqual(Array.from(decodeStream({ mode: 3, bytes: encodeMode3([5, -20, 0, 9]) }, 4)), [5, -20, 0, 9]);
});

test("mode 3: a wrong length trailer, a non-zero lead or a short stream is BAD_BLOCK", function () {
	var bytes = encodeMode3([1, 2, 3]);
	bytes[bytes.length - 1] ^= 1;
	assert.throws(function () { decodeMode3(bytes, 3); }, { code: "BAD_BLOCK", message: /length trailer/ });
	assert.throws(function () { decodeMode3(encodeMode3([1, 2, 3], { lead: 7 }), 3); }, { code: "BAD_BLOCK", message: /starts with symbol 7/ });
	assert.throws(function () { decodeMode3(Uint8Array.from([0, 0, 3]), 1); }, { code: "BAD_BLOCK", message: /too short/ });
});
