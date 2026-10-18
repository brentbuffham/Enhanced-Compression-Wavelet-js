// _dev/ecw-decode/testRounding.mjs
//==========================================================
// Scores rounding variants of the cracked level-0 -> level-1
// synthesis + BT.601 colour against the GDAL level-1 reference.
// Usage: node _dev/ecw-decode/testRounding.mjs <file.ecw> <level-1.tif>
//==========================================================

import fs from "node:fs";
import { openFile, levelPlanes } from "./levelPlanes.mjs";
import { readTiff } from "../../test/helpers/readTiff.js";

function clampIdx(i, n) { return i < 0 ? 0 : i >= n ? n - 1 : i; }

// even = s - avg(d[n-1], d[n]); odd = avg(s[n], s[n+1]) + d[n]; avg chosen by `avg`
function synth1d(s, d, n, avg) {
	var x = new Float64Array(n);
	for (var i = 0; i < n; i++) {
		var k = i >> 1;
		x[i] = (i & 1) === 0
			? s[clampIdx(k, s.length)] - avg(d[clampIdx(k - 1, d.length)], d[clampIdx(k, d.length)])
			: avg(s[clampIdx(k, s.length)], s[clampIdx(k + 1, s.length)]) + d[clampIdx(k, d.length)];
	}
	return x;
}

function synth2d(P, w, h, avg, rowsFirst) {
	var W = 2 * w, H = 2 * h;
	if (rowsFirst) {
		var lo = new Float64Array(W * h), hi = new Float64Array(W * h);
		for (var y = 0; y < h; y++) {
			lo.set(synth1d(P.LL.subarray(y * w, y * w + w), P.HL.subarray(y * w, y * w + w), W, avg), y * W);
			hi.set(synth1d(P.LH.subarray(y * w, y * w + w), P.HH.subarray(y * w, y * w + w), W, avg), y * W);
		}
		var out = new Float64Array(W * H);
		for (var x = 0; x < W; x++) {
			var s = new Float64Array(h), d = new Float64Array(h);
			for (y = 0; y < h; y++) { s[y] = lo[y * W + x]; d[y] = hi[y * W + x]; }
			var col = synth1d(s, d, H, avg);
			for (y = 0; y < H; y++) out[y * W + x] = col[y];
		}
		return out;
	}
	// columns first
	var loC = new Float64Array(w * H), hiC = new Float64Array(w * H);
	for (var x2 = 0; x2 < w; x2++) {
		var a = new Float64Array(h), b = new Float64Array(h), c = new Float64Array(h), e = new Float64Array(h);
		for (var y2 = 0; y2 < h; y2++) { a[y2] = P.LL[y2 * w + x2]; b[y2] = P.LH[y2 * w + x2]; c[y2] = P.HL[y2 * w + x2]; e[y2] = P.HH[y2 * w + x2]; }
		var l = synth1d(a, b, H, avg), r = synth1d(c, e, H, avg);
		for (y2 = 0; y2 < H; y2++) { loC[y2 * w + x2] = l[y2]; hiC[y2 * w + x2] = r[y2]; }
	}
	var out2 = new Float64Array(W * H);
	for (var y3 = 0; y3 < H; y3++) out2.set(synth1d(loC.subarray(y3 * w, y3 * w + w), hiC.subarray(y3 * w, y3 * w + w), W, avg), y3 * W);
	return out2;
}

var AVGS = {
	"exact": function (a, b) { return (a + b) / 2; },
	"floor": function (a, b) { return Math.floor((a + b) / 2); },
	"round": function (a, b) { return Math.floor((a + b + 1) / 2); },
	"trunc": function (a, b) { return Math.trunc((a + b) / 2); }
};
var COLOURS = {
	"round": function (v) { return Math.round(v); },
	"floor": function (v) { return Math.floor(v); },
	"trunc": function (v) { return Math.trunc(v); }
};

var L = levelPlanes(openFile(process.argv[2]), 0);
var ref = readTiff(new Uint8Array(fs.readFileSync(process.argv[3])));
var W = 2 * L.width;
Object.keys(AVGS).forEach(function (avgName) {
	[true, false].forEach(function (rowsFirst) {
		var B = [0, 1, 2].map(function (b) { return synth2d(L.planes[b], L.width, L.height, AVGS[avgName], rowsFirst); });
		Object.keys(COLOURS).forEach(function (cName) {
			var fix = COLOURS[cName], exact = 0, n = 0, bias = 0;
			for (var y = 0; y < ref.height; y++) for (var x = 0; x < ref.width; x++) {
				var i = y * W + x, ri = (y * ref.width + x) * 3, Y = B[0][i], U = B[1][i], V = B[2][i];
				var rgb = [Y + 1.402 * V, Y - 0.344136 * U - 0.714136 * V, Y + 1.772 * U];
				for (var c = 0; c < 3; c++) {
					var v = fix(rgb[c]); v = v < 0 ? 0 : v > 255 ? 255 : v;
					var d = v - ref.data[ri + c];
					if (d === 0) exact++; bias += d; n++;
				}
			}
			console.log(("avg " + avgName + (rowsFirst ? " rows-first" : " cols-first") + " colour " + cName).padEnd(40), "exact " + (100 * exact / n).toFixed(2) + "%  bias " + (bias / n).toFixed(3));
		});
	});
});
