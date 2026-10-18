// _dev/ecw-decode/searchInteger.mjs
//==========================================================
// Searches integer rounding for the two lifting steps
//   even = s - R1(d[n-1] + d[n]),  odd = R2(s[n] + s[n+1]) + d[n]
// (R = how the /2 is rounded) and per-channel colour offsets, over a
// two-level reconstruction scored against GDAL's level-2 reference.
// Usage: node _dev/ecw-decode/searchInteger.mjs <file.ecw> <level-2.tif>
//==========================================================

import fs from "node:fs";
import { openFile, levelPlanes } from "./levelPlanes.mjs";
import { readTiff } from "../../test/helpers/readTiff.js";

var HALF = {
	exact: function (v) { return v / 2; },
	floor: function (v) { return Math.floor(v / 2); },
	ceil: function (v) { return Math.ceil(v / 2); },
	trunc: function (v) { return Math.trunc(v / 2); }
};

function ci(i, n) { return i < 0 ? 0 : i >= n ? n - 1 : i; }
function synth1d(s, d, n, r1, r2) {
	var x = new Float64Array(n);
	for (var i = 0; i < n; i++) {
		var k = i >> 1;
		x[i] = (i & 1) === 0
			? s[ci(k, s.length)] - r1(d[ci(k - 1, d.length)] + d[ci(k, d.length)])
			: r2(s[ci(k, s.length)] + s[ci(k + 1, s.length)]) + d[ci(k, d.length)];
	}
	return x;
}
function synth2d(P, w, h, r1, r2) {
	var W = 2 * w, H = 2 * h, lo = new Float64Array(W * h), hi = new Float64Array(W * h);
	for (var y = 0; y < h; y++) {
		lo.set(synth1d(P.LL.subarray(y * w, y * w + w), P.HL.subarray(y * w, y * w + w), W, r1, r2), y * W);
		hi.set(synth1d(P.LH.subarray(y * w, y * w + w), P.HH.subarray(y * w, y * w + w), W, r1, r2), y * W);
	}
	var out = new Float64Array(W * H);
	for (var x = 0; x < W; x++) {
		var s = new Float64Array(h), d = new Float64Array(h);
		for (y = 0; y < h; y++) { s[y] = lo[y * W + x]; d[y] = hi[y * W + x]; }
		var col = synth1d(s, d, H, r1, r2);
		for (y = 0; y < H; y++) out[y * W + x] = col[y];
	}
	return out;
}

var f = openFile(process.argv[2]);
var ref = readTiff(new Uint8Array(fs.readFileSync(process.argv[3])));
var L0 = levelPlanes(f, 0), L1 = levelPlanes(f, 1);
var results = [];
Object.keys(HALF).forEach(function (n1) {
	Object.keys(HALF).forEach(function (n2) {
		var r1 = HALF[n1], r2 = HALF[n2];
		var planes = [0, 1, 2].map(function (b) {
			var l1 = synth2d(L0.planes[b], L0.width, L0.height, r1, r2), W1 = 2 * L0.width;
			var LL = new Float64Array(L1.width * L1.height);
			for (var y = 0; y < L1.height; y++) for (var x = 0; x < L1.width; x++) LL[y * L1.width + x] = l1[y * W1 + x];
			return synth2d({ LL: LL, LH: L1.planes[b].LH, HL: L1.planes[b].HL, HH: L1.planes[b].HH }, L1.width, L1.height, r1, r2);
		});
		var W = 2 * L1.width;
		[[0, 0, 0], [0.5, 0, 0.5]].forEach(function (off) {
			var exact = 0, n = 0;
			for (var y = 0; y < ref.height; y++) for (var x = 0; x < ref.width; x++) {
				var i = y * W + x, ri = (y * ref.width + x) * 3, Y = planes[0][i], U = planes[1][i], V = planes[2][i];
				var rgb = [Y + 1.402 * V + off[0], Y - 0.344136 * U - 0.714136 * V + off[1], Y + 1.772 * U + off[2]];
				for (var c = 0; c < 3; c++) { var v = Math.round(rgb[c]); v = v < 0 ? 0 : v > 255 ? 255 : v; if (v === ref.data[ri + c]) exact++; n++; }
			}
			results.push([100 * exact / n, "even " + n1 + ", odd " + n2 + ", colour offsets " + off.join("/")]);
		});
	});
});
results.sort(function (a, b) { return b[0] - a[0]; });
results.slice(0, 8).forEach(function (r) { console.log(r[0].toFixed(2) + "%  " + r[1]); });
