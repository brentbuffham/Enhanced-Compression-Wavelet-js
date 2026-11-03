// src/codec/dither.js
//==========================================================
// The ECW SDK adds a fixed dither to the finest image levels of
// highly compressed files (FINDINGS.md "output dither", measured by
// having the SDK decode crafted files and one real file):
//   - when: the header's compression target is 10 or more, the file
//     has 5 or more levels, and the image level being output is one
//     of the finest three (levelCount - 2 .. levelCount);
//   - what: luma (band 0) of yuv files, or the band of greyscale
//     files; other colour spaces are not dithered;
//   - how: one 64x64 table of eighths (-5 to +5) is added to the
//     level's pixels before the colour step floors them, indexed by
//     the pixel's position in the level, (y mod 64, x mod 64).
// It is output-only: levels that feed the next synthesis stay clean.
//==========================================================

var TILE = 64;
var MASK = TILE - 1;

// Table entries in eighths, row by row, as signed bytes
var TABLE_BASE64 =
	"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";
var table = null;

function ditherTable() {
	if (!table) {
		var raw = atob(TABLE_BASE64);
		table = new Float32Array(TILE * TILE);
		for (var i = 0; i < raw.length; i++) table[i] = (raw.charCodeAt(i) << 24 >> 24) / 8;
	}
	return table;
}

/**
 * Whether the SDK dithers image level `level` of this file, and which band.
 * @param {{compressionTarget:number, levelCount:number, bands:number, colorSpace:string}} header
 * @param {number} level - Image level being output (levelCount = full resolution).
 * @returns {number} The band to dither, or -1 for none.
 */
export function ditherBand(header, level) {
	if (header.compressionTarget < 10 || header.levelCount < 5 || level < header.levelCount - 2) return -1;
	if (header.colorSpace === "yuv" && header.bands >= 3) return 0;
	if (header.colorSpace === "greyscale") return 0;
	return -1;
}

/**
 * Add the dither to a window of one band in place.
 * @param {Float32Array} band - width x height values, row by row.
 * @param {number} width
 * @param {number} height
 * @param {number} x0 - Window origin within the image level.
 * @param {number} y0
 */
export function addDither(band, width, height, x0, y0) {
	var t = ditherTable();
	for (var y = 0; y < height; y++) {
		var row = ((y0 + y) & MASK) * TILE, o = y * width;
		for (var x = 0; x < width; x++) band[o + x] += t[row + ((x0 + x) & MASK)];
	}
}

/** The 64x64 table in eighths' units (a copy; for tests and tools). */
export function ditherTableEighths() {
	var t = ditherTable(), out = new Int8Array(t.length);
	for (var i = 0; i < t.length; i++) out[i] = t[i] * 8;
	return out;
}
