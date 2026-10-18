// src/codec/colour.js
//==========================================================
// Band 0 is luma, bands 1 and 2 are Cb- and Cr-like chroma. The ECW
// SDK converts exactly like this (FINDINGS.md "colour conversion",
// recovered by having the SDK decode crafted files):
//   1) floor Y, Cb and Cr to integers
//   2) R = Y + T_R(Cr), G = Y + T_GB(Cb) + T_GR(Cr), B = Y + T_B(Cb)
//   3) clamp to 0..255
// Each table is t(c) = floor(k * c + offset + 0.5). The constants
// reproduce all 256 entries of every table the SDK produced; they are
// close to BT.601 (1.402, -0.344136, -0.714136, 1.772) but not equal,
// and R and B carry a +1 (why all-zero data decodes to (1, 0, 1)).
//==========================================================

var K_R = 1.40228, OFF_R = 1.011;
var K_B = 1.77151, OFF_B = 1.0075;
var K_GB = -0.34349, OFF_GB = -0.0075;
var K_GR = -0.71464, OFF_GR = -0.03;

function tR(c) { return Math.floor(K_R * c + OFF_R + 0.5); }
function tB(c) { return Math.floor(K_B * c + OFF_B + 0.5); }
function tGB(c) { return Math.floor(K_GB * c + OFF_GB + 0.5); }
function tGR(c) { return Math.floor(K_GR * c + OFF_GR + 0.5); }

function clamp(v) {
	return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * The four chroma tables as functions of an integer chroma value.
 * @returns {{R:function(number):number, B:function(number):number, GB:function(number):number, GR:function(number):number}}
 */
export function colourTables() {
	return { R: tR, B: tB, GB: tGB, GR: tGR };
}

/**
 * Convert luma/chroma planes to RGBA the way the ECW SDK does.
 * @param {Float32Array} Y
 * @param {Float32Array} U - Cb-like band.
 * @param {Float32Array} V - Cr-like band.
 * @param {Uint8ClampedArray} rgba - Output, 4 bytes per pixel.
 */
export function yuvToRgba(Y, U, V, rgba) {
	for (var i = 0, o = 0; i < Y.length; i++, o += 4) {
		var y = Math.floor(Y[i]), u = Math.floor(U[i]), v = Math.floor(V[i]);
		rgba[o] = clamp(y + tR(v));
		rgba[o + 1] = clamp(y + tGB(u) + tGR(v));
		rgba[o + 2] = clamp(y + tB(u));
		rgba[o + 3] = 255;
	}
}

/**
 * Convert a single band to grey RGBA (floored like luma; not yet
 * verified against a 1-band SDK decode).
 * @param {Float32Array} G
 * @param {Uint8ClampedArray} rgba
 */
export function greyToRgba(G, rgba) {
	for (var i = 0, o = 0; i < G.length; i++, o += 4) {
		var g = clamp(Math.floor(G[i]));
		rgba[o] = g;
		rgba[o + 1] = g;
		rgba[o + 2] = g;
		rgba[o + 3] = 255;
	}
}
