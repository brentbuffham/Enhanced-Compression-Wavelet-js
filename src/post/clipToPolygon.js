// src/post/clipToPolygon.js
//==========================================================
// Optional `clipPolygon` post-step: pixels whose centre falls
// outside the polygon get alpha 0. Rings are [x, y] map
// coordinates; even-odd fill, so inner rings are holes.
// Scanline per output row: collect edge crossings with the
// half-open rule (y0 <= y) !== (y1 <= y), sort, and keep centres
// inside [xs[2i], xs[2i+1]). Output is north-up: row 0 is maxY.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";

function validateRings(rings) {
	if (!Array.isArray(rings)) {
		throw new EcwError(ERROR_CODES.INVALID_ARGUMENT, "clipPolygon must be an array of rings");
	}
	rings.forEach(function (ring, i) {
		if (!Array.isArray(ring) || ring.length < 3) {
			throw new EcwError(ERROR_CODES.INVALID_ARGUMENT, "clipPolygon ring " + i + " needs at least 3 points");
		}
		ring.forEach(function (pt) {
			if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
				throw new EcwError(ERROR_CODES.INVALID_ARGUMENT, "clipPolygon ring " + i + " has a non-finite point");
			}
		});
	});
}

/**
 * Set alpha to 0 outside the polygon. In place.
 * @param {Uint8ClampedArray} rgba
 * @param {number} width - Output width in pixels.
 * @param {number} height - Output height in pixels.
 * @param {{minX:number, minY:number, maxX:number, maxY:number}} bounds - Map extent of the output.
 * @param {Array<Array<[number, number]>>} rings
 * @returns {Uint8ClampedArray} the same array
 */
export function clipToPolygon(rgba, width, height, bounds, rings) {
	validateRings(rings);
	if (rings.length === 0) return rgba;
	var dx = (bounds.maxX - bounds.minX) / width;
	var dy = (bounds.maxY - bounds.minY) / height;
	var xs = [];
	for (var r = 0; r < height; r++) {
		// Step 1) Crossings of every edge with this row's centre line
		var y = bounds.maxY - (r + 0.5) * dy;
		xs.length = 0;
		for (var k = 0; k < rings.length; k++) {
			var ring = rings[k];
			for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				var y0 = ring[j][1];
				var y1 = ring[i][1];
				if ((y0 <= y) !== (y1 <= y)) {
					xs.push(ring[j][0] + (y - y0) * (ring[i][0] - ring[j][0]) / (y1 - y0));
				}
			}
		}
		xs.sort(function (a, b) { return a - b; });
		// Step 2) Clear every pixel whose centre is outside all spans
		var span = 0;
		for (var c = 0; c < width; c++) {
			var x = bounds.minX + (c + 0.5) * dx;
			while (span < xs.length && x >= xs[span + 1]) span += 2;
			var inside = span + 1 < xs.length && x >= xs[span];
			if (!inside) rgba[(r * width + c) * 4 + 3] = 0;
		}
	}
	return rgba;
}
