// test/format/EcwBlockFrame.test.js
//==========================================================
// Block framing: (streams - 1) u32 BE offsets relative to the
// header end, then mode-tagged streams, band-major.
// Run with: node --test test/format/EcwBlockFrame.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitBlockStreams, streamCount, STREAM_MODE } from "../../src/format/EcwBlockFrame.js";

// streams: [[mode, ...payload], ...]
function buildBlock(streams) {
	var header = (streams.length - 1) * 4;
	var total = header + streams.reduce(function (s, st) { return s + st.length; }, 0);
	var out = new Uint8Array(total);
	var view = new DataView(out.buffer);
	var rel = 0;
	streams.forEach(function (st, i) {
		if (i > 0) view.setUint32((i - 1) * 4, rel, false);
		out.set(st, header + rel);
		rel += st.length;
	});
	return out;
}

function emptyStreams(n) { return Array.from({ length: n }, function () { return [5]; }); }

test("STREAM_MODE values and streamCount", function () {
	assert.deepEqual(STREAM_MODE, { EMPTY: 5, CODED_A: 2, CODED_B: 6 });
	assert.ok(Object.isFrozen(STREAM_MODE));
	assert.equal(streamCount(3, 0), 12);
	assert.equal(streamCount(3, 4), 9);
	assert.equal(streamCount(1, 0), 4);
});

test("level 0 block: 12 streams labelled band-major with LL first", function () {
	var streams = emptyStreams(12);
	streams[0] = [2, 0xAA, 0xBB];
	streams[5] = [6, 0xCC];
	var out = splitBlockStreams(buildBlock(streams), 3, 0);
	assert.equal(out.length, 12);
	assert.deepEqual(out.map(function (s) { return s.band + s.subband; }),
		["0LL", "0LH", "0HL", "0HH", "1LL", "1LH", "1HL", "1HH", "2LL", "2LH", "2HL", "2HH"]);
	assert.deepEqual(out[0], { band: 0, subband: "LL", mode: 2, bytes: Uint8Array.from([0xAA, 0xBB]) });
	assert.deepEqual(out[5], { band: 1, subband: "LH", mode: 6, bytes: Uint8Array.from([0xCC]) });
	assert.equal(out[1].mode, 5);
	assert.equal(out[1].bytes.length, 0);
});

test("other levels: 9 streams without LL", function () {
	var streams = emptyStreams(9);
	streams[8] = [2, 1, 2, 3];
	var out = splitBlockStreams(buildBlock(streams), 3, 2);
	assert.deepEqual(out.map(function (s) { return s.band + s.subband; }),
		["0LH", "0HL", "0HH", "1LH", "1HL", "1HH", "2LH", "2HL", "2HH"]);
	assert.deepEqual(Array.from(out[8].bytes), [1, 2, 3]);
});

test("all-empty edge block is 44 + 12 bytes", function () {
	var block = buildBlock(emptyStreams(12));
	assert.equal(block.length, 56);
	assert.ok(splitBlockStreams(block, 3, 0).every(function (s) { return s.mode === 5; }));
});

test("block shorter than its header throws BAD_BLOCK", function () {
	assert.throws(function () { splitBlockStreams(new Uint8Array(10), 3, 0); }, { code: "BAD_BLOCK", offset: 44 });
});

test("falling stream offset throws at that header field", function () {
	var block = buildBlock(emptyStreams(9));
	new DataView(block.buffer).setUint32(8, 1, false); // stream 3 starts before stream 2
	assert.throws(function () { splitBlockStreams(block, 3, 1); }, { code: "BAD_BLOCK", offset: 8 });
});

test("stream offset past the block throws at that header field", function () {
	var block = buildBlock(emptyStreams(9));
	new DataView(block.buffer).setUint32(28, 999, false);
	assert.throws(function () { splitBlockStreams(block, 3, 1); }, { code: "BAD_BLOCK", offset: 28 });
});

test("zero-length stream throws at its start", function () {
	var block = buildBlock(emptyStreams(9));
	new DataView(block.buffer).setUint32(4, 1, false); // stream 2 starts where stream 1 does
	assert.throws(function () { splitBlockStreams(block, 3, 1); }, { code: "BAD_BLOCK", offset: 32 + 1 });
});

test("unknown mode byte throws at the stream start", function () {
	var streams = emptyStreams(9);
	streams[2] = [9];
	assert.throws(function () { splitBlockStreams(buildBlock(streams), 3, 1); }, { code: "BAD_BLOCK", offset: 32 + 2 });
});

test("empty-mode stream longer than one byte throws", function () {
	var streams = emptyStreams(9);
	streams[0] = [5, 0];
	assert.throws(function () { splitBlockStreams(buildBlock(streams), 3, 1); }, { code: "BAD_BLOCK", offset: 32 });
});
