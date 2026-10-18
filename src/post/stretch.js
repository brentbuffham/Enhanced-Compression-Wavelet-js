// src/post/stretch.js
//==========================================================
// Optional contrast stretch, a display enhancement in the style of
// QGIS's min/max stretch with a cumulative count cut. ECW imagery is
// often stored low-contrast; viewers stretch it when drawing. Off by
// default so output matches GDAL; the same stretch should be used for
// every read of a file (compute it once with stretchFromPixels or
// EcwReader.computeStretch) so tiles and zoom levels agree.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";

function invalid(message) {
	return new EcwError(ERROR_CODES.INVALID_ARGUMENT, message);
}

function checkStretch(s) {
	if (!s || !Array.isArray(s.min) || !Array.isArray(s.max) || s.min.length !== 3 || s.max.length !== 3) {
		throw invalid("stretch must be { min: [r, g, b], max: [r, g, b] }");
	}
	for (var c = 0; c < 3; c++) {
		if (!Number.isFinite(s.min[c]) || !Number.isFinite(s.max[c]) || s.max[c] <= s.min[c]) {
			throw invalid("stretch band " + c + " needs finite min < max");
		}
	}
}

/**
 * Stretch R, G and B linearly so min -> 0 and max -> 255 per band, clamped. In place.
 * @param {Uint8ClampedArray} rgba
 * @param {{min:number[], max:number[]}} stretch
 * @returns {Uint8ClampedArray} the same array
 */
export function applyStretch(rgba, stretch) {
	checkStretch(stretch);
	// one lookup table per band
	var tables = [0, 1, 2].map(function (c) {
		var t = new Uint8ClampedArray(256), lo = stretch.min[c], range = stretch.max[c] - lo;
		for (var v = 0; v < 256; v++) t[v] = Math.round((v - lo) * 255 / range);
		return t;
	});
	for (var i = 0; i < rgba.length; i += 4) {
		rgba[i] = tables[0][rgba[i]];
		rgba[i + 1] = tables[1][rgba[i + 1]];
		rgba[i + 2] = tables[2][rgba[i + 2]];
	}
	return rgba;
}

/**
 * Per-band cumulative count cut over the foreground pixels of an RGBA image.
 * Pixels with alpha 0, or with every band <= ignoreBelow (the near-black
 * off-footprint background), are left out.
 * @param {Uint8ClampedArray} rgba
 * @param {{cut?:number[], ignoreBelow?:number}} [options] - cut in percent, default [2, 98];
 *   ignoreBelow default 3.
 * @returns {{min:number[], max:number[]}}
 */
export function stretchFromPixels(rgba, options) {
	var o = options || {};
	var cut = o.cut || [2, 98];
	var ignoreBelow = o.ignoreBelow === undefined ? 3 : o.ignoreBelow;
	if (!Array.isArray(cut) || cut.length !== 2 || !(cut[0] >= 0) || !(cut[1] <= 100) || !(cut[0] < cut[1])) {
		throw invalid("cut must be [low, high] percentages with 0 <= low < high <= 100");
	}
	var hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
	var n = 0;
	for (var i = 0; i < rgba.length; i += 4) {
		if (rgba[i + 3] === 0) continue;
		if (rgba[i] <= ignoreBelow && rgba[i + 1] <= ignoreBelow && rgba[i + 2] <= ignoreBelow) continue;
		hist[0][rgba[i]]++;
		hist[1][rgba[i + 1]]++;
		hist[2][rgba[i + 2]]++;
		n++;
	}
	if (!n) throw invalid("no foreground pixels to compute a stretch from");
	// value of the k-th smallest sample (0-based)
	function at(h, k) {
		for (var v = 0, seen = 0; v < 256; v++) {
			seen += h[v];
			if (seen > k) return v;
		}
		return 255;
	}
	var kLow = Math.floor(cut[0] / 100 * (n - 1)), kHigh = Math.floor(cut[1] / 100 * (n - 1));
	var min = [], max = [];
	for (var c = 0; c < 3; c++) {
		min.push(at(hist[c], kLow));
		// a flat band would give max == min; keep the stretch valid
		max.push(Math.max(at(hist[c], kHigh), min[c] + 1));
	}
	return { min: min, max: max };
}
