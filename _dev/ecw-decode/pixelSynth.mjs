// _dev/ecw-decode/pixelSynth.mjs
// Per-pixel reference synthesis for probing block-boundary rules.
// opts.zeroDetailsInExact: in an exact-path block every detail coefficient (including neighbours') reads as 0.
function clamp(i, n) { return i < 0 ? 0 : i >= n ? n - 1 : i; }
function q4(v) { return Math.floor(v * 4) / 4; }
export function pixelSynth(src, x0, y0, x1, y1, opts) {
	var w = src.w, h = src.h;
	function P(plane, c, k) { return plane[(clamp(k, h) - src.y0) * src.width + clamp(c, w) - src.x0]; }
	var out = new Float32Array((x1 - x0) * (y1 - y0));
	for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) {
		var kx = x >> 1, ky = y >> 1;
		var general = !src.floorAt || src.floorAt(kx, ky);
		var zero = opts.zeroDetailsInExact && !general;
		var D = function (plane, c, k) { return zero ? 0 : P(plane, c, k); };
		var oddY = (y & 1) === 1, oddX = (x & 1) === 1;
		function col(lowPlane, highPlane, c, floorIt) {
			if (!oddY) return (lowPlane === src.LL ? P(lowPlane, c, ky) : D(lowPlane, c, ky)) - (D(highPlane, c, ky - 1) + D(highPlane, c, ky)) / 2;
			var a = lowPlane === src.LL ? (P(lowPlane, c, ky) + P(lowPlane, c, ky + 1)) / 2 : (D(lowPlane, c, ky) + D(lowPlane, c, ky + 1)) / 2;
			if (floorIt) a = q4(a);
			return a + D(highPlane, c, ky);
		}
		var fl = general && oddX && oddY;
		var v = !oddX
			? col(src.LL, src.LH, kx, false) - (col(src.HL, src.HH, kx - 1, false) + col(src.HL, src.HH, kx, false)) / 2
			: (col(src.LL, src.LH, kx, fl) + col(src.LL, src.LH, kx + 1, fl)) / 2 + col(src.HL, src.HH, kx, fl);
		out[(y - y0) * (x1 - x0) + x - x0] = v;
	}
	return out;
}
