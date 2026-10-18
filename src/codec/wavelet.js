// src/codec/wavelet.js
//==========================================================
// Windowed inverse wavelet for one ECW level (FINDINGS.md
// "inverse wavelet and colour"). Subbands of size w x h synthesise
// an image of 2w x 2h. 1-D rule, indices clamped to [0, len):
//   even x[2k]   = s[k] - (d[k-1] + d[k]) / 2
//   odd  x[2k+1] = (s[k] + s[k+1]) / 2 + d[k]
// Columns first (LL with LH; HL with HH), then rows. Odd-odd output
// pixels interpolate vertical averages floored to quarters; all other
// pixels are exact. Matches the ECW SDK's general path (FINDINGS.md
// "synthesis rounding").
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

// 1-D synthesis split into its two parts, for output samples [o0, o1):
//   sPart: even s[k], odd (s[k] + s[k+1]) / 2 (roundAverage, when set, applied to the average)
//   dPart: even -(d[k-1] + d[k]) / 2, odd d[k]
// s(k) / d(k) take clamped global indices.
function synthPart(f, isDetail, len, o0, o1, out, outStride, outOffset, roundAverage) {
	for (var i = o0; i < o1; i++) {
		var k = i >> 1;
		var v;
		if (isDetail) {
			v = (i & 1) === 0 ? -(f(clamp(k - 1, len)) + f(k)) / 2 : f(k);
		} else if ((i & 1) === 0) {
			v = f(k);
		} else {
			v = (f(k) + f(clamp(k + 1, len))) / 2;
			if (roundAverage) v = roundAverage(v);
		}
		out[outOffset + (i - o0) * outStride] = v;
	}
}

// Subband bits for src.subbandsAt()
var HAS_LH = 1;
var HAS_HL = 2;
var HAS_HH = 4;
var ALL_SUBBANDS = HAS_LH | HAS_HL | HAS_HH;

/**
 * Synthesise output window [x0, x1) x [y0, y1) of the 2w x 2h image.
 * Columns first (LL with LH, HL with HH), then rows. Odd-odd output
 * pixels interpolate vertical averages floored to quarters; every other
 * pixel uses exact arithmetic (the ECW SDK's general path).
 * @param {{w:number, h:number, x0:number, y0:number, width:number, height:number,
 *   LL:Float32Array, LH:Float32Array, HL:Float32Array, HH:Float32Array}} src
 *   Coefficient window: plane values for coefficient columns [x0, x0+width)
 *   and rows [y0, y0+height); it must cover requiredCoefficientWindow().
 *   Optional src.subbandsAt(kx, ky) -> bits (1 LH, 2 HL, 4 HH) of the detail
 *   subbands whose streams are non-empty in the block holding coefficient
 *   (kx, ky). The output pixels of (kx, ky) ignore a missing subband entirely,
 *   neighbours' coefficients included; with none at all they take the exact
 *   path, pure LL interpolation without quarter flooring (as the SDK does).
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
	// Column parts of coefficient column c at output row y: LL / HL exact (lle, hle)
	// and with odd-row averages floored to quarters (llq, hlq); LH / HH detail parts
	var size = cols * outH;
	var lle = new Float32Array(size), llq = new Float32Array(size), lhd = new Float32Array(size);
	var hle = new Float32Array(size), hlq = new Float32Array(size), hhd = new Float32Array(size);

	// Step 1) Column pass for every needed coefficient column
	for (var c = need.x0; c < need.x1; c++) {
		var col = c - src.x0;
		var plane;
		var at = function (k) { return plane[(clamp(k, h) - src.y0) * src.width + col]; };
		var o = c - need.x0;
		plane = src.LL;
		synthPart(at, false, h, y0, y1, lle, cols, o, null);
		synthPart(at, false, h, y0, y1, llq, cols, o, quarterFloor);
		plane = src.LH;
		synthPart(at, true, h, y0, y1, lhd, cols, o, null);
		plane = src.HL;
		synthPart(at, false, h, y0, y1, hle, cols, o, null);
		synthPart(at, false, h, y0, y1, hlq, cols, o, quarterFloor);
		plane = src.HH;
		synthPart(at, true, h, y0, y1, hhd, cols, o, null);
	}

	// Step 2) Row pass: even rows and even columns exact; odd-odd from the floored columns.
	// The block holding the output pixel decides which subbands take part.
	var out = new Float32Array(outW * outH);
	for (var r = 0; r < outH; r++) {
		var base = r * cols - need.x0;
		var oddRow = ((y0 + r) & 1) === 1;
		var ky = (y0 + r) >> 1;
		var llQ = oddRow ? llq : lle;
		var hlQ = oddRow ? hlq : hle;
		for (var x = x0; x < x1; x++) {
			var kx = x >> 1;
			var m = src.subbandsAt ? src.subbandsAt(kx, ky) : ALL_SUBBANDS;
			var i0 = base + kx;
			var i1 = base + clamp(kx + 1, w);
			var v;
			if (m === 0) {
				v = (x & 1) === 0 ? lle[i0] : (lle[i0] + lle[i1]) / 2;
			} else if ((x & 1) === 0) {
				var im = base + clamp(kx - 1, w);
				v = lle[i0] + ((m & HAS_LH) ? lhd[i0] : 0) - (highPass(m, hle, hhd, im) + highPass(m, hle, hhd, i0)) / 2;
			} else {
				var lh0 = (m & HAS_LH) ? lhd[i0] : 0;
				var lh1 = (m & HAS_LH) ? lhd[i1] : 0;
				v = (llQ[i0] + lh0 + llQ[i1] + lh1) / 2 + highPass(m, hlQ, hhd, i0);
			}
			out[r * outW + x - x0] = v;
		}
	}
	return out;
}

// Column high-pass sample: HL part plus HH part, each only when present
function highPass(m, hl, hh, i) {
	return ((m & HAS_HL) ? hl[i] : 0) + ((m & HAS_HH) ? hh[i] : 0);
}
