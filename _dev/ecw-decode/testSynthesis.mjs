// _dev/ecw-decode/testSynthesis.mjs
//==========================================================
// Rebuilds the level-1 image from level-0 subbands with candidate
// 1-D synthesis rules (applied rows then columns), fits a 3x4 colour
// matrix from the three rebuilt bands to the GDAL level-1 reference,
// and reports the mean / max error per model.
// Usage: node _dev/ecw-decode/testSynthesis.mjs <file.ecw> <level-1.tif>
//==========================================================

import fs from "node:fs";
import { openFile, levelPlanes } from "./levelPlanes.mjs";
import { solve } from "./fitLevel0.mjs";
import { readTiff } from "../../test/helpers/readTiff.js";

// 1-D synthesis: s (length ns), d (length nd) -> x (length n); edges mirror
export var MODELS = {
	"empirical": function (s, d, n) {
		var x = new Float64Array(n);
		function S(i) { return s[Math.max(0, Math.min(s.length - 1, i))]; }
		function D(i) { return d[Math.max(0, Math.min(d.length - 1, i))]; }
		for (var i = 0; i < n; i++) x[i] = i % 2 === 0 ? S(i / 2) - (D(i / 2 - 1) + D(i / 2)) / 2 : (S((i - 1) / 2) + S((i + 1) / 2)) / 2 + D((i - 1) / 2);
		return x;
	},
	"5/3": function (s, d, n) {
		var x = new Float64Array(n);
		function D(i) { return d[Math.max(0, Math.min(d.length - 1, i))]; }
		for (var i = 0; i < n; i += 2) x[i] = s[i / 2] - (D(i / 2 - 1) + D(i / 2)) / 4;
		for (i = 1; i < n; i += 2) x[i] = d[(i - 1) / 2] + (x[i - 1] + (i + 1 < n ? x[i + 1] : x[i - 1])) / 2;
		return x;
	},
	"5/3 d*2": function (s, d, n) {
		return MODELS["5/3"](s, Array.from(d, function (v) { return v * 2; }), n);
	},
	"haar": function (s, d, n) {
		var x = new Float64Array(n);
		for (var i = 0; i < n; i++) x[i] = i % 2 === 0 ? s[i >> 1] - d[Math.min(d.length - 1, i >> 1)] : s[i >> 1] + d[i >> 1];
		return x;
	}
};

// 2-D: LL, LH (low x / high y?), HL, HH planes of size w x h -> image 2w x 2h
export function synth2d(model, P, w, h, hiXName, hiYName) {
	var W = 2 * w, H = 2 * h;
	var lowRows = new Float64Array(W * h), highRows = new Float64Array(W * h);
	var hiX = P[hiXName], hiY = P[hiYName];
	for (var y = 0; y < h; y++) {
		var lr = model(P.LL.subarray(y * w, y * w + w), hiX.subarray(y * w, y * w + w), W);
		var hr = model(hiY.subarray(y * w, y * w + w), P.HH.subarray(y * w, y * w + w), W);
		lowRows.set(lr, y * W);
		highRows.set(hr, y * W);
	}
	var out = new Float64Array(W * H);
	for (var x = 0; x < W; x++) {
		var s = new Float64Array(h), d = new Float64Array(h);
		for (y = 0; y < h; y++) { s[y] = lowRows[y * W + x]; d[y] = highRows[y * W + x]; }
		var col = model(s, d, H);
		for (y = 0; y < H; y++) out[y * W + x] = col[y];
	}
	return out;
}

if (process.argv[1] && process.argv[1].endsWith("testSynthesis.mjs")) {
	var L = levelPlanes(openFile(process.argv[2]), 0);
	var ref = readTiff(new Uint8Array(fs.readFileSync(process.argv[3])));
	var W = 2 * L.width;
	Object.keys(MODELS).forEach(function (name) {
		[["HL", "LH"], ["LH", "HL"]].forEach(function (assign) {
			var bands = [0, 1, 2].map(function (b) { return synth2d(MODELS[name], L.planes[b], L.width, L.height, assign[0], assign[1]); });
			var rows = [], ch = [[], [], []];
			for (var y = 2; y < ref.height - 2; y++) for (var x = 2; x < ref.width - 2; x++) {
				var i = y * W + x, ri = (y * ref.width + x) * 3;
				rows.push([bands[0][i], bands[1][i], bands[2][i], 1]);
				for (var c = 0; c < 3; c++) ch[c].push(ref.data[ri + c]);
			}
			var out = [];
			[0, 1, 2].forEach(function (c) {
				var k = solve(rows, ch[c]);
				var e = 0, m = 0;
				rows.forEach(function (r, n) { var p = k[0] * r[0] + k[1] * r[1] + k[2] * r[2] + k[3]; var d = Math.abs(p - ch[c][n]); e += d; if (d > m) m = d; });
				out.push("RGB"[c] + " " + (e / rows.length).toFixed(3) + "/" + m.toFixed(1) + " [" + k.map(function (v) { return v.toFixed(3); }).join(" ") + "]");
			});
			console.log((name + " hiX=" + assign[0]).padEnd(22), out.join("  "));
		});
	});
}
