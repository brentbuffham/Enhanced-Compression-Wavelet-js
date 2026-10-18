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
	var LL = src.LL, LH = src.LH, HL = src.HL, HH = src.HH, stride = src.width;
	// Column parts of coefficient column c at output row y, row-major [r * cols + c - need.x0]:
	// LL / HL exact (lle, hle), on odd rows also with averages floored to quarters (llq, hlq);
	// LH / HH detail parts (lhd, hhd)
	var size = cols * outH;
	var lle = new Float32Array(size), llq = new Float32Array(size), lhd = new Float32Array(size);
	var hle = new Float32Array(size), hlq = new Float32Array(size), hhd = new Float32Array(size);

	// Step 1) Column pass, one output row at a time (planes are row-major)
	for (var r = 0; r < outH; r++) {
		var y = y0 + r, k = y >> 1, o = r * cols;
		var rowK = (clamp(k, h) - src.y0) * stride + need.x0 - src.x0;
		var c, n = cols, i0, i1;
		if ((y & 1) === 0) {
			// even: s[k] - (d[k-1] + d[k]) / 2, split into the s part and the d part
			var rowM = (clamp(k - 1, h) - src.y0) * stride + need.x0 - src.x0;
			for (c = 0; c < n; c++) {
				i0 = rowK + c;
				i1 = rowM + c;
				lle[o + c] = LL[i0];
				lhd[o + c] = -(LH[i1] + LH[i0]) / 2;
				hle[o + c] = HL[i0];
				hhd[o + c] = -(HH[i1] + HH[i0]) / 2;
			}
		} else {
			// odd: (s[k] + s[k+1]) / 2 + d[k]
			var rowN = (clamp(k + 1, h) - src.y0) * stride + need.x0 - src.x0;
			for (c = 0; c < n; c++) {
				i0 = rowK + c;
				i1 = rowN + c;
				var avgL = (LL[i0] + LL[i1]) / 2, avgH = (HL[i0] + HL[i1]) / 2;
				lle[o + c] = avgL;
				llq[o + c] = Math.floor(avgL * 4) / 4;
				lhd[o + c] = LH[i0];
				hle[o + c] = avgH;
				hlq[o + c] = Math.floor(avgH * 4) / 4;
				hhd[o + c] = HH[i0];
			}
		}
	}

	// Step 2) Row pass: even rows and even columns exact; odd-odd from the floored columns.
	// The block holding the output pixel decides which subbands take part.
	var out = new Float32Array(outW * outH);
	var kx0 = x0 >> 1, kx1 = ((x1 - 1) >> 1) + 1;
	var masks = new Uint8Array(kx1 - kx0);
	var subbandsAt = src.subbandsAt;
	for (r = 0; r < outH; r++) {
		var base = r * cols - need.x0;
		var oddRow = ((y0 + r) & 1) === 1;
		var ky = (y0 + r) >> 1;
		var llQ = oddRow ? llq : lle;
		var hlQ = oddRow ? hlq : hle;
		var all = true;
		for (var kx = kx0; kx < kx1; kx++) {
			var mk = subbandsAt ? subbandsAt(kx, ky) : ALL_SUBBANDS;
			masks[kx - kx0] = mk;
			if (mk !== ALL_SUBBANDS) all = false;
		}
		var at = r * outW - x0;
		for (var x = x0; x < x1; x++) {
			var kxx = x >> 1;
			var m = all ? ALL_SUBBANDS : masks[kxx - kx0];
			var j0 = base + kxx;
			var j1 = base + (kxx + 1 < w ? kxx + 1 : w - 1);
			var v;
			if ((x & 1) === 0) {
				var jm = base + (kxx > 0 ? kxx - 1 : 0);
				if (m === ALL_SUBBANDS) {
					v = lle[j0] + lhd[j0] - ((hle[jm] + hhd[jm]) + (hle[j0] + hhd[j0])) / 2;
				} else if (m === 0) {
					v = lle[j0];
				} else {
					v = lle[j0] + ((m & HAS_LH) ? lhd[j0] : 0) - (highPass(m, hle, hhd, jm) + highPass(m, hle, hhd, j0)) / 2;
				}
			} else if (m === ALL_SUBBANDS) {
				v = (llQ[j0] + lhd[j0] + llQ[j1] + lhd[j1]) / 2 + (hlQ[j0] + hhd[j0]);
			} else if (m === 0) {
				v = (lle[j0] + lle[j1]) / 2;
			} else {
				var lh0 = (m & HAS_LH) ? lhd[j0] : 0;
				var lh1 = (m & HAS_LH) ? lhd[j1] : 0;
				v = (llQ[j0] + lh0 + llQ[j1] + lh1) / 2 + highPass(m, hlQ, hhd, j0);
			}
			out[at + x] = v;
		}
	}
	return out;
}

// Column high-pass sample: HL part plus HH part, each only when present
function highPass(m, hl, hh, i) {
	return ((m & HAS_HL) ? hl[i] : 0) + ((m & HAS_HH) ? hh[i] : 0);
}
