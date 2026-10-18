// src/format/EcwBlockFrame.js
//==========================================================
// Splits one ECW block into its mode-tagged streams
// (FINDINGS.md "block framing"):
//   (streams - 1) u32 BE offsets, relative to the end of this header
//   streams, band-major; level 0 has LL, LH, HL, HH per band,
//   other levels LH, HL, HH per band.
// Each stream starts with a mode byte: 5 = empty (exactly 1 byte),
// 2 and 6 = two coding methods still being worked out.
// ⚠️ Stream counts bands x 4 / bands x 3 are only proven for 3-band
// files so far.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";

/** Stream mode bytes seen so far. */
export var STREAM_MODE = Object.freeze({ EMPTY: 5, CODED_A: 2, CODED_B: 6 });

var LEVEL0_SUBBANDS = ["LL", "LH", "HL", "HH"];
var DETAIL_SUBBANDS = ["LH", "HL", "HH"];

/**
 * Number of streams in a block.
 * @param {number} bands
 * @param {number} level - Level-record index (0 = coarsest).
 * @returns {number}
 */
export function streamCount(bands, level) {
	return bands * (level === 0 ? LEVEL0_SUBBANDS.length : DETAIL_SUBBANDS.length);
}

function bad(message, offset) {
	return new EcwError(ERROR_CODES.BAD_BLOCK, message, offset);
}

/**
 * Split a block into streams. Offsets in errors are relative to the block start.
 * @param {Uint8Array} bytes - The whole block.
 * @param {number} bands
 * @param {number} level
 * @returns {Array<{band:number, subband:string, mode:number, bytes:Uint8Array}>}
 *   `bytes` is the stream payload after the mode byte (a view into the block).
 */
export function splitBlockStreams(bytes, bands, level) {
	var subbands = level === 0 ? LEVEL0_SUBBANDS : DETAIL_SUBBANDS;
	var count = streamCount(bands, level);
	var headerLength = (count - 1) * 4;
	if (bytes.length < headerLength) throw bad("block shorter than its stream table", headerLength);
	var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	var bodyLength = bytes.length - headerLength;

	// Step 1) Stream start offsets, relative to the header end
	var starts = [0];
	for (var k = 1; k < count; k++) {
		var field = (k - 1) * 4;
		var rel = view.getUint32(field, false);
		if (rel < starts[k - 1]) throw bad("stream " + k + " starts before stream " + (k - 1), field);
		if (rel > bodyLength) throw bad("stream " + k + " starts past the block", field);
		starts.push(rel);
	}

	// Step 2) Slice each stream and read its mode byte
	var streams = [];
	for (k = 0; k < count; k++) {
		var start = headerLength + starts[k];
		var end = k + 1 < count ? headerLength + starts[k + 1] : bytes.length;
		if (end <= start) throw bad("stream " + k + " is empty", start);
		var mode = bytes[start];
		if (mode !== STREAM_MODE.EMPTY && mode !== STREAM_MODE.CODED_A && mode !== STREAM_MODE.CODED_B) {
			throw bad("stream " + k + " has unknown mode " + mode, start);
		}
		if (mode === STREAM_MODE.EMPTY && end - start !== 1) throw bad("empty stream " + k + " is longer than one byte", start);
		streams.push({
			band: Math.floor(k / subbands.length),
			subband: subbands[k % subbands.length],
			mode: mode,
			bytes: bytes.subarray(start + 1, end)
		});
	}
	return streams;
}
