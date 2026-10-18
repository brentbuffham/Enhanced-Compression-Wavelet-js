// src/post/applyTransparency.js
//==========================================================
// Optional `transparentBelow` post-step. ECW v2 has no alpha band
// and off-footprint areas are lossy near-black (0-2, smeared at
// edges), so a small threshold clears them without punching holes
// in real shadows. Off by default so output matches GDAL.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";

/**
 * Set alpha to 0 where R, G and B are all <= threshold. In place.
 * @param {Uint8ClampedArray} rgba
 * @param {number} threshold - Integer 0-255.
 * @returns {Uint8ClampedArray} the same array
 */
export function applyTransparency(rgba, threshold) {
	if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
		throw new EcwError(ERROR_CODES.INVALID_ARGUMENT, "transparentBelow must be an integer 0-255, got " + threshold);
	}
	for (var i = 0; i < rgba.length; i += 4) {
		if (rgba[i] <= threshold && rgba[i + 1] <= threshold && rgba[i + 2] <= threshold) rgba[i + 3] = 0;
	}
	return rgba;
}
