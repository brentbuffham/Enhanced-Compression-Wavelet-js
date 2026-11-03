// src/codec/rangeCoded.js
//==========================================================
// Mode 3 streams (FINDINGS.md "mode 3 streams"): range-coded
// bytes under an adaptive order-0 model.
//   - Coder: a carry-handling range coder with a 31-bit range,
//     7 extra bits and an 8-bit header byte (the stream's mode
//     byte plays that role, so the payload starts after it).
//   - Model: quasistatic frequencies over 257 symbols (256 bytes
//     plus an end symbol that real streams never use), total
//     4096, uniform start, rebuilt in batches whose length doubles
//     from 36 up to a target of 2000.
//   - Payload symbols: one lead byte (0; decoded but not counted
//     in the model), then each coefficient as a little-endian
//     int16 (low byte, high byte), row by row over the block.
//   - The last 3 bytes are the payload length, big-endian.
// This is the textbook quasistatic model from the general range
// coding literature (Schindler's range coder package and Dario
// Phong's write-up of it), identified by matching measured band
// edges.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";

var SYMBOLS = 257;
var END_SYMBOL = 256;
var TOTAL_BITS = 12;
var TOTAL = 1 << TOTAL_BITS;
var RESCALE_TARGET = 2000;
var EXTRA_BITS = 7;
var BOTTOM = 1 << 23;

function bad(message) {
	return new EcwError(ERROR_CODES.BAD_BLOCK, message);
}

// Step 1) The quasistatic model: cumulative counts `cf` are fixed
// between rebuilds; `newf` collects increments for the next one.
function createModel() {
	var m = { cf: new Int32Array(SYMBOLS + 1), newf: new Int32Array(SYMBOLS), rescale: (SYMBOLS >> 4) | 2, nextleft: 0, left: 0, incr: 0 };
	m.cf[SYMBOLS] = TOTAL;
	var base = Math.floor(TOTAL / SYMBOLS), extra = TOTAL % SYMBOLS;
	for (var i = 0; i < SYMBOLS; i++) m.newf[i] = i < extra ? base + 1 : base;
	rebuild(m);
	return m;
}

function rebuild(m) {
	if (m.nextleft) {
		m.incr++;
		m.left = m.nextleft;
		m.nextleft = 0;
		return;
	}
	if (m.rescale < RESCALE_TARGET) m.rescale = Math.min(m.rescale << 1, RESCALE_TARGET);
	var cf = m.cf, newf = m.newf, run = TOTAL, missing = TOTAL;
	for (var i = SYMBOLS - 1; i > 0; i--) {
		run -= newf[i];
		cf[i] = run;
		var half = (newf[i] >> 1) | 1;
		missing -= half;
		newf[i] = half;
	}
	newf[0] = (newf[0] >> 1) | 1;
	missing -= newf[0];
	m.incr = Math.floor(missing / m.rescale);
	m.nextleft = missing % m.rescale;
	m.left = m.rescale - m.nextleft;
}

function update(m, s) {
	if (m.left <= 0) rebuild(m);
	m.left--;
	m.newf[s] += m.incr;
}

// Largest s with cf[s] <= c
function findSymbol(cf, c) {
	var lo = 0, hi = SYMBOLS - 1;
	while (lo < hi) {
		var mid = (lo + hi + 1) >> 1;
		if (cf[mid] <= c) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * Decode a mode-3 (range-coded bytes) stream.
 * @param {Uint8Array} bytes - Payload after the mode byte.
 * @param {number} count - Coefficients in the block.
 * @returns {Int32Array}
 */
export function decodeMode3(bytes, count) {
	var len = bytes.length;
	if (len < 4) throw bad("mode-3 stream too short");
	var trailer = (bytes[len - 3] << 16) | (bytes[len - 2] << 8) | bytes[len - 1];
	if (trailer !== len) throw bad("mode-3 length trailer says " + trailer + " bytes, stream has " + len);

	// Step 2) Range decoder state (the coder reads ahead; past the end it reads zeros)
	var p = 1;
	var buffer = bytes[0];
	var low = buffer >> (8 - EXTRA_BITS);
	var range = 1 << EXTRA_BITS;
	var model = createModel();
	var cf = model.cf;

	function symbol() {
		while (range <= BOTTOM) {
			low = (low << 8) | ((buffer << EXTRA_BITS) & 0xff);
			buffer = p < len ? bytes[p] : 0;
			p++;
			low |= buffer >> (8 - EXTRA_BITS);
			range *= 256;
		}
		var help = Math.floor(range / TOTAL);
		var t = Math.floor(low / help);
		var s = findSymbol(cf, t >= TOTAL ? TOTAL - 1 : t);
		var lt = cf[s], sf = cf[s + 1] - lt, tmp = help * lt;
		low -= tmp;
		if (lt + sf < TOTAL) range = help * sf;
		else range -= tmp;
		return s;
	}

	// Step 3) Lead byte, then low/high byte pairs
	var lead = symbol();
	if (lead !== 0) throw bad("mode-3 stream starts with symbol " + lead + "; only 0 has been seen so far");
	var out = new Int32Array(count);
	for (var n = 0; n < count; n++) {
		var lo = symbol();
		update(model, lo);
		var hi = symbol();
		update(model, hi);
		if (lo === END_SYMBOL || hi === END_SYMBOL) throw bad("mode-3 stream ends after " + n + " of " + count + " values");
		out[n] = ((hi << 8) | lo) << 16 >> 16;
	}
	if (p > len + 1) throw bad("mode-3 stream decodes past its end");
	return out;
}
