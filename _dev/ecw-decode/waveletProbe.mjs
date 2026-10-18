// _dev/ecw-decode/waveletProbe.mjs: probe copy of src/codec/wavelet.js with PROBE hooks (mid-pass rounding)
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

import { EcwError, ERROR_CODES } from "../../src/errors.js";

/** Probe hooks: mid(v, isHigh, level) rounds row-pass output before the column pass. */
export var PROBE = globalThis.__ECW_PROBE || (globalThis.__ECW_PROBE = { mid: null });

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
		var half = PROBE.half || function (x) { return x / 2; };
		var v = (i & 1) === 0
			? s(k) - half(d(clamp(k - 1, len)) + d(k))
			: half(s(k) + s(clamp(k + 1, len))) + d(k);
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
// Columns-first variant: vertical pass on (LL, LH) and (HL, HH), then horizontal.
// PROBE.colOdd(v, w) can round odd-row (averaged) column results.
function colsFirstWindow(src, x0, y0, x1, y1) {
	var need = requiredCoefficientWindow(src.w, src.h, x0, y0, x1, y1);
	var outW = x1 - x0, outH = y1 - y0, cols = need.x1 - need.x0;
	var lo = new Float32Array(cols * outH), hi = new Float32Array(cols * outH);
	var w = src.w, h = src.h;
	for (var c = need.x0; c < need.x1; c++) {
		var cc = c - src.x0;
		for (var y = y0; y < y1; y++) {
			var k = y >> 1, odd = (y & 1) === 1;
			function S(plane, kk) { return plane[(clamp(kk, h) - src.y0) * src.width + cc]; }
			var hf = PROBE.halfV || PROBE.half || function (q) { return q / 2; };
			var hvo = PROBE.hVodd || hf, hve = PROBE.hVeven || hf;
			var vL = odd ? hvo(S(src.LL, k) + S(src.LL, k + 1)) + S(src.LH, k) : S(src.LL, k) - hve(S(src.LH, k - 1) + S(src.LH, k));
			var vH = odd ? hvo(S(src.HL, k) + S(src.HL, k + 1)) + S(src.HH, k) : S(src.HL, k) - hve(S(src.HH, k - 1) + S(src.HH, k));
			if (PROBE.colOdd) { vL = PROBE.colOdd(vL, w, odd); vH = PROBE.colOdd(vH, w, odd); }
			lo[(y - y0) * cols + (c - need.x0)] = vL;
			hi[(y - y0) * cols + (c - need.x0)] = vH;
		}
	}
	var out = new Float32Array(outW * outH);
	for (var yy = 0; yy < outH; yy++) {
		var base = yy * cols;
		for (var x = x0; x < x1; x++) {
			var kx = x >> 1;
			function L(kk) { return lo[base + clamp(kk, w) - need.x0]; }
			function H(kk) { return hi[base + clamp(kk, w) - need.x0]; }
			var hf2 = PROBE.halfH || PROBE.half || function (q) { return q / 2; };
			var hho = PROBE.hHodd || hf2, hhe = PROBE.hHeven || hf2;
			var ov = (x & 1) === 0 ? L(kx) - hhe(H(kx - 1) + H(kx), w) : hho(L(kx) + L(kx + 1), w) + H(kx);
			out[yy * outW + x - x0] = PROBE.rowOut ? PROBE.rowOut(ov, w, (x & 1) === 1, (y0 + yy) & 1) : ov;
		}
	}
	return out;
}

// Generic two-pass synthesis for probing: cfg = { order: "cols" | "rows", firstOdd: fn(sum), firstEven: fn(sum), secondOdd: fn(sum), secondEven: fn(sum) }
// Each fn receives the sum of two neighbours and returns the halved (possibly rounded) value.
function twoPass(src, x0, y0, x1, y1, cfg) {
	var w = src.w, h = src.h;
	function S(plane, cx, cy) { return plane[(clamp(cy, h) - src.y0) * src.width + clamp(cx, w) - src.x0]; }
	function synthAt(sPlaneGet, dPlaneGet, i, n, odd, even) {
		var k = i >> 1;
		return (i & 1) === 0 ? sPlaneGet(k) - even(dPlaneGet(clamp(k - 1, n)) + dPlaneGet(k)) : odd(sPlaneGet(k) + sPlaneGet(clamp(k + 1, n))) + dPlaneGet(k);
	}
	var out = new Float32Array((x1 - x0) * (y1 - y0));
	for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) {
		var v;
		if (cfg.order === "cols") {
			// first vertical on columns kx (low-x plane pair LL/LH and high-x pair HL/HH), then horizontal
			var colL = function (cx) { return synthAt(function (k) { return S(src.LL, cx, k); }, function (k) { return S(src.LH, cx, k); }, y, h, cfg.firstOdd, cfg.firstEven); };
			var colH = function (cx) { return synthAt(function (k) { return S(src.HL, cx, k); }, function (k) { return S(src.HH, cx, k); }, y, h, cfg.firstOdd, cfg.firstEven); };
			v = synthAt(colL, colH, x, w, cfg.secondOdd, cfg.secondEven);
		} else {
			var rowL = function (cy) { return synthAt(function (k) { return S(src.LL, k, cy); }, function (k) { return S(src.HL, k, cy); }, x, w, cfg.firstOdd, cfg.firstEven); };
			var rowH = function (cy) { return synthAt(function (k) { return S(src.LH, k, cy); }, function (k) { return S(src.HH, k, cy); }, x, w, cfg.firstOdd, cfg.firstEven); };
			v = synthAt(rowL, rowH, y, h, cfg.secondOdd, cfg.secondEven);
		}
		out[(y - y0) * (x1 - x0) + x - x0] = v;
	}
	return out;
}

export function synthesizeWindow(src, x0, y0, x1, y1) {
	if (PROBE.levelCfg) { var cfg = PROBE.levelCfg(src.w); if (cfg) return twoPass(src, x0, y0, x1, y1, cfg); }
	if (PROBE.colsFirst) return colsFirstWindow(src, x0, y0, x1, y1);
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

	if (PROBE.mid) { for (var q = 0; q < lo.length; q++) { lo[q] = PROBE.mid(lo[q], false, src.w); hi[q] = PROBE.mid(hi[q], true, src.w); } }
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
