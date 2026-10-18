// src/codec/wavelet.js
//==========================================================
// Windowed inverse wavelet for one ECW level (FINDINGS.md
// "inverse wavelet and colour"). Subbands of size w x h synthesise
// an image of 2w x 2h. 1-D rule, indices clamped to [0, len):
//   even x[2k]   = s[k] - (d[k-1] + d[k]) / 2
//   odd  x[2k+1] = (s[k] + s[k+1]) / 2 + d[k]
// Rows first (LL with HL; LH with HH), then columns (low, high).
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

// 1-D synthesis of output samples [o0, o1) into out; s(k) / d(k) take clamped global indices
function synth1d(s, d, len, o0, o1, out, outStride, outOffset) {
	for (var i = o0; i < o1; i++) {
		var k = i >> 1;
		var v = (i & 1) === 0
			? s(k) - (d(clamp(k - 1, len)) + d(k)) / 2
			: (s(k) + s(clamp(k + 1, len))) / 2 + d(k);
		out[outOffset + (i - o0) * outStride] = v;
	}
}

/**
 * Synthesise output window [x0, x1) x [y0, y1) of the 2w x 2h image.
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
	var rows = need.y1 - need.y0;
	var lo = new Float32Array(outW * rows);
	var hi = new Float32Array(outW * rows);
	var cx = 0;
	var rowBase = 0;
	var plane = null;
	var w = src.w;
	function at(k) { return plane[rowBase + clamp(k, w) - src.x0]; }
	var sPlane, dPlane;
	function sx(k) { plane = sPlane; return at(k); }
	function dx(k) { plane = dPlane; return at(k); }

	// Step 1) Row pass for every needed coefficient row
	for (var r = need.y0; r < need.y1; r++) {
		rowBase = (r - src.y0) * src.width;
		sPlane = src.LL; dPlane = src.HL;
		synth1d(sx, dx, w, x0, x1, lo, 1, (r - need.y0) * outW);
		sPlane = src.LH; dPlane = src.HH;
		synth1d(sx, dx, w, x0, x1, hi, 1, (r - need.y0) * outW);
	}

	// Step 2) Column pass
	var out = new Float32Array(outW * outH);
	var h = src.h;
	for (cx = 0; cx < outW; cx++) {
		var col = cx;
		synth1d(
			function (k) { return lo[(clamp(k, h) - need.y0) * outW + col]; },
			function (k) { return hi[(clamp(k, h) - need.y0) * outW + col]; },
			h, y0, y1, out, outW, cx
		);
	}
	return out;
}
