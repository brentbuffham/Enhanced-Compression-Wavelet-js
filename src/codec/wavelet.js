// src/codec/wavelet.js
//==========================================================
// Windowed inverse wavelet for one ECW level (FINDINGS.md
// "inverse wavelet and colour"). Subbands of size w x h synthesise
// an image of 2w x 2h. 1-D rule, indices clamped to [0, len):
//   even x[2k]   = s[k] - (d[k-1] + d[k]) / 2
//   odd  x[2k+1] = (s[k] + s[k+1]) / 2 + d[k]
// Columns first (LL with LH; HL with HH), odd-row averages floored to
// quarters, then rows exactly: matches the ECW SDK's general path
// (FINDINGS.md "synthesis rounding").
// Only a window is produced, from a coefficient window padded by one
// (requiredCoefficientWindow), so huge levels never load whole.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";

/**
 * Coefficient window needed to synthesise output window [x0, x1) x [y0, y1).
 * @param {number} w - Subband width (coefficients).
 * @param {number} h - Subband height.
 * @returns {{x0:number, y0:number, x1:number, y1:number}} exclusive end, clamped
 */
export function requiredCoefficientWindow(w, h, x0, y0, x1, y1) {
	return {
		x0: Math.max(0, (x0 >> 1) - 1),
		y0: Math.max(0, (y0 >> 1) - 1),
		x1: Math.min(w, ((x1 - 1) >> 1) + 2),
		y1: Math.min(h, ((y1 - 1) >> 1) + 2)
	};
}

function clamp(i, n) {
	return i < 0 ? 0 : i >= n ? n - 1 : i;
}

// The SDK holds the vertical pass's averaged samples to quarter
// precision (floor), then runs the horizontal pass exactly
function quarterFloor(v) {
	return Math.floor(v * 4) / 4;
}

// 1-D synthesis of output samples [o0, o1) into out; s(k) / d(k) take clamped global indices.
// roundAverage, when set, is applied to the odd samples' (s[k] + s[k+1]) / 2 term.
function synth1d(s, d, len, o0, o1, out, outStride, outOffset, roundAverage) {
	for (var i = o0; i < o1; i++) {
		var k = i >> 1;
		var v;
		if ((i & 1) === 0) {
			v = s(k) - (d(clamp(k - 1, len)) + d(k)) / 2;
		} else {
			var avg = (s(k) + s(clamp(k + 1, len))) / 2;
			v = (roundAverage ? roundAverage(avg) : avg) + d(k);
		}
		out[outOffset + (i - o0) * outStride] = v;
	}
}

/**
 * Synthesise output window [x0, x1) x [y0, y1) of the 2w x 2h image.
 * Columns first (LL with LH, HL with HH; odd-row averages floored to
 * quarters, as the ECW SDK does), then rows (exact).
 * @param {{w:number, h:number, x0:number, y0:number, width:number, height:number,
 *   LL:Float32Array, LH:Float32Array, HL:Float32Array, HH:Float32Array}} src
 *   Coefficient window: plane values for coefficient columns [x0, x0+width)
 *   and rows [y0, y0+height); it must cover requiredCoefficientWindow().
 * @returns {Float32Array} (x1 - x0) * (y1 - y0) samples, row-major
 */
export function synthesizeWindow(src, x0, y0, x1, y1) {
	var need = requiredCoefficientWindow(src.w, src.h, x0, y0, x1, y1);
	if (need.x0 < src.x0 || need.y0 < src.y0 || need.x1 > src.x0 + src.width || need.y1 > src.y0 + src.height) {
		throw new EcwError(ERROR_CODES.INVALID_ARGUMENT, "coefficient window does not cover the requested output");
	}
	var outW = x1 - x0;
	var outH = y1 - y0;
	var cols = need.x1 - need.x0;
	var w = src.w;
	var h = src.h;
	// lo[y][c] / hi[y][c]: vertical synthesis of coefficient column c at output row y
	var lo = new Float32Array(cols * outH);
	var hi = new Float32Array(cols * outH);

	// Step 1) Column pass for every needed coefficient column
	for (var c = need.x0; c < need.x1; c++) {
		var col = c - src.x0;
		var sPlane, dPlane;
		var sv = function (k) { return sPlane[(clamp(k, h) - src.y0) * src.width + col]; };
		var dv = function (k) { return dPlane[(clamp(k, h) - src.y0) * src.width + col]; };
		sPlane = src.LL; dPlane = src.LH;
		synth1d(sv, dv, h, y0, y1, lo, cols, c - need.x0, quarterFloor);
		sPlane = src.HL; dPlane = src.HH;
		synth1d(sv, dv, h, y0, y1, hi, cols, c - need.x0, quarterFloor);
	}

	// Step 2) Row pass
	var out = new Float32Array(outW * outH);
	for (var r = 0; r < outH; r++) {
		var base = r * cols - need.x0;
		synth1d(
			function (k) { return lo[base + clamp(k, w)]; },
			function (k) { return hi[base + clamp(k, w)]; },
			w, x0, x1, out, 1, r * outW, null
		);
	}
	return out;
}
