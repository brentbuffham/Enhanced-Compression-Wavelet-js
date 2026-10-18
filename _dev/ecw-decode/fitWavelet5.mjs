// _dev/ecw-decode/fitWavelet5.mjs (5x5 taps variant of fitWavelet.mjs)
//==========================================================
// Recovers the inverse-wavelet taps from GDAL's level-1 reference:
// pixel (2x+i, 2y+j) of the level-1 image is fitted, per phase (i,j),
// as a linear function of band-0 subband coefficients of level 0 at
// offsets -1..1 around (x, y), plus chroma LL and a constant.
// Usage: node _dev/ecw-decode/fitWavelet.mjs <file.ecw> <level-1.tif> [channel 0|1|2]
//==========================================================

import fs from "node:fs";
import { openFile, levelPlanes } from "./levelPlanes.mjs";
import { solve } from "./fitLevel0.mjs";
import { readTiff } from "../../test/helpers/readTiff.js";

var L = levelPlanes(openFile(process.argv[2]), 0);
var ref = readTiff(new Uint8Array(fs.readFileSync(process.argv[3])));
var channel = Number(process.argv[4] || 1);
var W = L.width, H = L.height;
function at(b, sb, x, y) {
	if (x < 0 || y < 0 || x >= W || y >= H) return 0;
	return L.planes[b][sb][y * W + x];
}
var SB = ["LL", "LH", "HL", "HH"];
var offsets = [-2, -1, 0, 1, 2];
[[0, 0], [1, 0], [0, 1], [1, 1]].forEach(function (phase) {
	var rows = [], target = [];
	for (var y = 2; y < Math.floor(ref.height / 2) - 2; y++) {
		for (var x = 2; x < Math.floor(ref.width / 2) - 2; x++) {
			var r = [];
			SB.forEach(function (sb) { offsets.forEach(function (dy) { offsets.forEach(function (dx) { r.push(at(0, sb, x + dx, y + dy)); }); }); });
			r.push(at(1, "LL", x, y), at(2, "LL", x, y), 1);
			rows.push(r);
			target.push(ref.data[((2 * y + phase[1]) * ref.width + 2 * x + phase[0]) * 3 + channel]);
		}
	}
	var k = solve(rows, target);
	var err = 0;
	rows.forEach(function (r, n) { var p = 0; for (var i = 0; i < r.length; i++) p += k[i] * r[i]; err += Math.abs(p - target[n]); });
	console.log("phase " + phase + "  mean|err| " + (err / rows.length).toFixed(3));
	SB.forEach(function (sb, s) {
		var g = k.slice(s * 25, s * 25 + 25).map(function (v) { return (v >= 0 ? " " : "") + v.toFixed(3); });
		for (var rr = 0; rr < 5; rr++) console.log("  " + (rr === 0 ? sb : "  ") + "  " + g.slice(rr * 5, rr * 5 + 5).join(" "));
	});
});
