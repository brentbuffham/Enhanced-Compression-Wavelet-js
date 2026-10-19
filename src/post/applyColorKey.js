// src/post/applyColorKey.js
//==========================================================
// Colour-key transparency. A key is a colour with a tolerance
// below and above it; a pixel whose R, G and B all sit inside a
// key's range becomes transparent. transparentBelow (black plus
// N), transparentAbove (white minus 255-N) and transparentColor
// all become keys, so readRegion makes a single pass for all three.
// Matching is on the output RGB, after colour conversion.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";

function isByte(v) {
	return Number.isInteger(v) && v >= 0 && v <= 255;
}

function invalid(name, message) {
	return new EcwError(ERROR_CODES.INVALID_ARGUMENT, name + " " + message);
}

function parseColor(color, name) {
	if (typeof color === "string") {
		if (!/^#[0-9a-f]{6}$/i.test(color)) throw invalid(name, "colour must be \"#rrggbb\" or [r, g, b], got " + JSON.stringify(color));
		var n = parseInt(color.slice(1), 16);
		return [n >> 16, (n >> 8) & 255, n & 255];
	}
	if (!Array.isArray(color) || color.length !== 3 || !color.every(isByte)) {
		throw invalid(name, "colour must be \"#rrggbb\" or [r, g, b] with integers 0-255, got " + JSON.stringify(color));
	}
	return color.slice();
}

function tolerance(v, name, which) {
	if (v === undefined) return 0;
	if (!isByte(v)) throw invalid(name, which + " must be an integer 0-255, got " + JSON.stringify(v));
	return v;
}

/**
 * Validate and normalise colour keys to [{color:[r,g,b], below, above}].
 * @param {Object|Object[]} keys - {color:"#rrggbb"|[r,g,b], below?:number, above?:number}, or a list.
 * @param {string} [name] - Option name for error messages.
 * @returns {{color:number[], below:number, above:number}[]}
 */
function normaliseKeys(keys, name) {
	var list = Array.isArray(keys) ? keys : [keys];
	if (keys === null || keys === undefined || list.length === 0) throw invalid(name, "needs at least one {color, below?, above?}");
	return list.map(function (k) {
		if (k === null || typeof k !== "object") throw invalid(name, "entries must be {color, below?, above?}, got " + JSON.stringify(k));
		return { color: parseColor(k.color, name), below: tolerance(k.below, name, "below"), above: tolerance(k.above, name, "above") };
	});
}

/**
 * Set alpha to 0 where a pixel's R, G and B all sit inside a key's
 * color - below .. color + above range (clamped to 0-255). In place.
 * @param {Uint8ClampedArray} rgba
 * @param {Object|Object[]} keys - {color:"#rrggbb"|[r,g,b], below?:number, above?:number}, or a list.
 * @returns {Uint8ClampedArray} the same array
 */
export function applyColorKey(rgba, keys) {
	var list = normaliseKeys(keys, "applyColorKey");
	// lo/hi per key, 6 numbers each: rLo, rHi, gLo, gHi, bLo, bHi
	var ranges = new Int16Array(list.length * 6);
	list.forEach(function (k, j) {
		for (var c = 0; c < 3; c++) {
			ranges[j * 6 + c * 2] = k.color[c] - k.below;
			ranges[j * 6 + c * 2 + 1] = k.color[c] + k.above;
		}
	});
	for (var i = 0; i < rgba.length; i += 4) {
		var r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
		for (var o = 0; o < ranges.length; o += 6) {
			if (r >= ranges[o] && r <= ranges[o + 1] && g >= ranges[o + 2] && g <= ranges[o + 3] && b >= ranges[o + 4] && b <= ranges[o + 5]) {
				rgba[i + 3] = 0;
				break;
			}
		}
	}
	return rgba;
}

/**
 * Turn readRegion's transparentBelow / transparentAbove / transparentColor
 * options into colour keys, validating them.
 * @param {{transparentBelow?:number, transparentAbove?:number, transparentColor?:Object|Object[]}} o
 * @returns {{color:number[], below:number, above:number}[]|null} null when none are set
 */
export function colorKeysFromOptions(o) {
	var keys = [];
	if (o.transparentBelow !== undefined) {
		if (!isByte(o.transparentBelow)) throw invalid("transparentBelow", "must be an integer 0-255, got " + JSON.stringify(o.transparentBelow));
		keys.push({ color: [0, 0, 0], below: 0, above: o.transparentBelow });
	}
	if (o.transparentAbove !== undefined) {
		if (!isByte(o.transparentAbove)) throw invalid("transparentAbove", "must be an integer 0-255, got " + JSON.stringify(o.transparentAbove));
		keys.push({ color: [255, 255, 255], below: 255 - o.transparentAbove, above: 0 });
	}
	if (o.transparentColor !== undefined) keys = keys.concat(normaliseKeys(o.transparentColor, "transparentColor"));
	return keys.length ? keys : null;
}
