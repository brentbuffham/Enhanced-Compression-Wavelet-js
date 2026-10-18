// examples/browser/lib/colorScale.js
//==========================================================
// Log-scaled colours for the block-size map: tiny blocks
// (empty background) are dark, detailed blocks bright.
//==========================================================

/** Colour stops from smallest to largest block. */
export var COLOR_STOPS = [[20, 24, 48], [32, 140, 150], [250, 232, 90]];

/**
 * Log range of the non-zero sizes.
 * @param {Uint32Array} sizes
 * @returns {{minLog:number, maxLog:number}}
 */
export function sizeRange(sizes) {
	var min = Infinity;
	var max = -Infinity;
	for (var i = 0; i < sizes.length; i++) {
		if (sizes[i] === 0) continue;
		if (sizes[i] < min) min = sizes[i];
		if (sizes[i] > max) max = sizes[i];
	}
	if (min === Infinity) return { minLog: 0, maxLog: 0 };
	return { minLog: Math.log(min), maxLog: Math.log(max) };
}

/**
 * @param {number} size - Block byte length.
 * @param {number} minLog
 * @param {number} maxLog
 * @returns {number[]} [r, g, b]
 */
export function blockSizeColor(size, minLog, maxLog) {
	if (size === 0) return [0, 0, 0];
	var t = maxLog > minLog ? (Math.log(size) - minLog) / (maxLog - minLog) : 1;
	t = Math.min(1, Math.max(0, t));
	var span = t * (COLOR_STOPS.length - 1);
	var i = Math.min(COLOR_STOPS.length - 2, Math.floor(span));
	var f = span - i;
	var a = COLOR_STOPS[i];
	var b = COLOR_STOPS[i + 1];
	return [0, 1, 2].map(function (k) { return Math.round(a[k] + (b[k] - a[k]) * f); });
}
