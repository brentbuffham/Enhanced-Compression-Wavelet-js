// src/codec/streams.js
//==========================================================
// Coefficient stream decoders (FINDINGS.md "mode 6 streams",
// "mode 2 streams"). Each returns exactly `count` coefficients,
// row by row over the block's extent in its level.
//   mode 5: empty, all zeros
//   mode 6: u16 LE words; top 2 bits 00 = +m, 01 = -m, 10 = m zeros
//   mode 2: u16 LE node count N, pre-order Huffman tree of N tokens
//           (0x00 internal, 0x80 + u16 word leaf, 0x4v +v, 0x5v -v,
//           0x6v v zeros), then codes read LSB-first, bit 0 = left
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";
import { STREAM_MODE } from "../format/EcwBlockFrame.js";

var TAG_PLUS = 0;
var TAG_MINUS = 1;
var TAG_RUN = 2;
// Guards recursion on corrupt input; real trees are far shallower
var MAX_TREE_DEPTH = 2048;

function bad(message) {
	return new EcwError(ERROR_CODES.BAD_BLOCK, message);
}

/**
 * Decode a mode-6 (run-length word) stream.
 * @param {Uint8Array} bytes - Payload after the mode byte.
 * @param {number} count - Coefficients in the block extent.
 * @returns {Int32Array}
 */
export function decodeMode6(bytes, count) {
	if (bytes.length % 2) throw bad("mode-6 stream has an odd byte length");
	var out = new Int32Array(count);
	var n = 0;
	for (var i = 0; i < bytes.length; i += 2) {
		var w = bytes[i] | (bytes[i + 1] << 8);
		var tag = w >> 14;
		var m = w & 0x3FFF;
		if (tag === TAG_RUN) {
			n += m;
			if (n > count) throw bad("mode-6 zero run overshoots the block");
		} else if (tag === TAG_PLUS || tag === TAG_MINUS) {
			if (n >= count) throw bad("mode-6 stream has more values than the block");
			out[n++] = tag === TAG_PLUS ? m : -m;
		} else {
			throw bad("mode-6 word with unknown tag 3");
		}
	}
	if (n !== count) throw bad("mode-6 stream decodes to " + n + " values, block has " + count);
	return out;
}

// A leaf is { value, run }: run > 0 means `run` zeros
function leafFromTag(tag, m) {
	if (tag === TAG_PLUS) return { value: m, run: 0 };
	if (tag === TAG_MINUS) return { value: -m, run: 0 };
	if (tag === TAG_RUN) return { value: 0, run: m };
	throw bad("mode-2 leaf with unknown tag 3");
}

function readTree(bytes) {
	if (bytes.length < 3) throw bad("mode-2 stream too short");
	var expected = bytes[0] | (bytes[1] << 8);
	var p = 2;
	var nodes = 0;
	function node(depth) {
		if (p >= bytes.length) throw bad("mode-2 tree runs past the stream");
		if (depth > MAX_TREE_DEPTH) throw bad("mode-2 tree is deeper than " + MAX_TREE_DEPTH);
		if (++nodes > expected) throw bad("mode-2 tree is larger than its node count");
		var t = bytes[p++];
		if (t === 0x00) return { left: node(depth + 1), right: node(depth + 1) };
		if (t === 0x80) {
			if (p + 2 > bytes.length) throw bad("mode-2 tree runs past the stream");
			var w = bytes[p] | (bytes[p + 1] << 8);
			p += 2;
			return { leaf: leafFromTag(w >> 14, w & 0x3FFF) };
		}
		var kind = t >> 4;
		if (kind < 4 || kind > 6 || (t & 15) === 0) throw bad("mode-2 tree has unknown token 0x" + t.toString(16));
		return { leaf: leafFromTag(kind - 4, t & 15) };
	}
	var root = node(0);
	if (nodes !== expected) throw bad("mode-2 tree has " + nodes + " nodes, header says " + expected);
	return { root: root, dataStart: p };
}

/**
 * Decode a mode-2 (Huffman-coded run-length) stream.
 * @param {Uint8Array} bytes - Payload after the mode byte.
 * @param {number} count - Coefficients in the block extent.
 * @returns {Int32Array}
 */
export function decodeMode2(bytes, count) {
	var tree = readTree(bytes);
	var out = new Int32Array(count);
	var n = 0;
	var pos = tree.dataStart * 8;
	var end = bytes.length * 8;
	while (n < count) {
		var node = tree.root;
		while (!node.leaf) {
			if (pos >= end) throw bad("mode-2 data ends after " + n + " of " + count + " values");
			node = ((bytes[pos >> 3] >> (pos & 7)) & 1) === 0 ? node.left : node.right;
			pos++;
		}
		var leaf = node.leaf;
		if (leaf.run) {
			n += leaf.run;
			if (n > count) throw bad("mode-2 zero run overshoots the block");
		} else {
			out[n++] = leaf.value;
		}
	}
	return out;
}

/**
 * Decode any stream from splitBlockStreams().
 * @param {{mode:number, bytes:Uint8Array}} stream
 * @param {number} count
 * @returns {Int32Array}
 */
export function decodeStream(stream, count) {
	if (stream.mode === STREAM_MODE.EMPTY) return new Int32Array(count);
	if (stream.mode === STREAM_MODE.CODED_B) return decodeMode6(stream.bytes, count);
	return decodeMode2(stream.bytes, count);
}
