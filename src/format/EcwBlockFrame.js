// src/format/EcwBlockFrame.js
//==========================================================
// Splits one ECW block into its mode-tagged streams
// (FINDINGS.md "block framing"):
//   (streams - 1) u32 BE offsets, relative to the end of this header
//   streams, band-major; level 0 has LL, LH, HL, HH per band,
//   other levels LH, HL, HH per band.
// Each stream starts with a mode byte. Decoded: 5 = empty (exactly
// 1 byte), 2 = Huffman-coded run-length symbols, 3 = range-coded
// bytes, 6 = run-length words.
// Any other mode raises UNSUPPORTED_MODE.
// ⚠️ Stream counts bands x 4 / bands x 3 are only proven for 3-band
// files so far.
//==========================================================

import { EcwError, ERROR_CODES, SAMPLE_REQUEST } from "../errors.js";

/** Stream modes the library decodes. */
export var STREAM_MODE = Object.freeze({ EMPTY: 5, CODED_A: 2, CODED_B: 6, RANGE_CODED: 3 });

/** @returns {boolean} true if the library decodes stream mode m */
export function isSupportedMode(m) {
	return m === STREAM_MODE.EMPTY || m === STREAM_MODE.CODED_A || m === STREAM_MODE.CODED_B || m === STREAM_MODE.RANGE_CODED;
}

/**
 * The UNSUPPORTED_MODE error for a stream, asking for a sample file.
 * @param {number} mode
 * @param {string} where - e.g. "stream 1"
 * @param {number} [offset] - File (or block) offset of the mode byte.
 * @returns {EcwError}
 */
export function unsupportedModeError(mode, where, offset) {
	var e = new EcwError(ERROR_CODES.UNSUPPORTED_MODE, where + " uses stream mode " + mode + ", which ecw-js does not decode yet. " + SAMPLE_REQUEST, offset);
	e.mode = mode;
	return e;
}

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

/**
 * A block's streams, all empty: what skip mode decodes a block it can't frame as.
 * @returns {Array<{band:number, subband:string, mode:number, bytes:Uint8Array}>}
 */
export function emptyBlockStreams(bands, level) {
	var subbands = level === 0 ? LEVEL0_SUBBANDS : DETAIL_SUBBANDS;
	var out = [];
	for (var k = 0; k < streamCount(bands, level); k++) {
		out.push({ band: Math.floor(k / subbands.length), subband: subbands[k % subbands.length], mode: STREAM_MODE.EMPTY, bytes: new Uint8Array(0) });
	}
	return out;
}

/**
 * Split a block into streams.
 * @param {Uint8Array} bytes - The whole block.
 * @param {number} bands
 * @param {number} level
 * @param {{offset?:number, keepUnsupported?:boolean}} [options]
 *   offset: the block's file offset, so error offsets are file offsets
 *   (default 0: offsets within the block). keepUnsupported: return streams in
 *   modes the library doesn't decode instead of raising UNSUPPORTED_MODE.
 * @returns {Array<{band:number, subband:string, mode:number, bytes:Uint8Array}>}
 *   `bytes` is the stream payload after the mode byte (a view into the block).
 */
export function splitBlockStreams(bytes, bands, level, options) {
	var base = options && options.offset ? options.offset : 0;
	var keep = !!(options && options.keepUnsupported);
	function bad(message, offset) {
		return new EcwError(ERROR_CODES.BAD_BLOCK, message, base + offset);
	}
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
		if (!keep && !isSupportedMode(mode)) throw unsupportedModeError(mode, "stream " + k, base + start);
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
