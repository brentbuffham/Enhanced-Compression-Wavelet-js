// src/codec/colour.js
//==========================================================
// Band 0 is luma, bands 1 and 2 are Cb- and Cr-like chroma
// (FINDINGS.md "inverse wavelet and colour"). BT.601 inverse:
//   R = Y + 1.402 Cr, G = Y - 0.344136 Cb - 0.714136 Cr, B = Y + 1.772 Cb
// ⚠️ The +0.5 on R and B is the best match to the ECW SDK found so far
// (all-zero coefficients come out as (1, 0, 1) there too); exact parity
// with the SDK is still open, see FINDINGS.md "the last ±1".
//==========================================================

var R_OFFSET = 0.5;
var B_OFFSET = 0.5;

function toByte(v) {
	v = Math.round(v);
	return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Convert luma/chroma planes to RGBA.
 * @param {Float32Array} Y
 * @param {Float32Array} U - Cb-like band.
 * @param {Float32Array} V - Cr-like band.
 * @param {Uint8ClampedArray} rgba - Output, 4 bytes per pixel.
 */
export function yuvToRgba(Y, U, V, rgba) {
	for (var i = 0, o = 0; i < Y.length; i++, o += 4) {
		var y = Y[i], u = U[i], v = V[i];
		rgba[o] = toByte(y + 1.402 * v + R_OFFSET);
		rgba[o + 1] = toByte(y - 0.344136 * u - 0.714136 * v);
		rgba[o + 2] = toByte(y + 1.772 * u + B_OFFSET);
		rgba[o + 3] = 255;
	}
}

/**
 * Convert a single band to grey RGBA.
 * @param {Float32Array} G
 * @param {Uint8ClampedArray} rgba
 */
export function greyToRgba(G, rgba) {
	for (var i = 0, o = 0; i < G.length; i++, o += 4) {
		var g = toByte(G[i]);
		rgba[o] = g;
		rgba[o + 1] = g;
		rgba[o + 2] = g;
		rgba[o + 3] = 255;
	}
}
