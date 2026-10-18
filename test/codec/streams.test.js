// test/codec/streams.test.js
//==========================================================
// Stream decoders: mode 6 (run-length words), mode 2 (Huffman
// tree + LSB-first codes), mode 5 (empty).
// Run with: node --test test/codec/streams.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeMode6, decodeMode2, decodeStream } from "../../src/codec/streams.js";
import { encodeMode2 } from "../helpers/encodeMode2.js";

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
