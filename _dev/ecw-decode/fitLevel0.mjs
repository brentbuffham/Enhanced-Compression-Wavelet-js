// _dev/ecw-decode/fitLevel0.mjs
// Least-squares fit of the level-0 GDAL reference (each RGB channel) against level-0 coefficient planes.
// Usage: node _dev/ecw-decode/fitLevel0.mjs <file.ecw> <ref.tif> <termSet>
//   termSet: "LL" (3 LL planes) or "all" (LL + band details)
import fs from "node:fs";
import { openFile, levelPlanes } from "./levelPlanes.mjs";
import { readTiff } from "../../test/helpers/readTiff.js";

export function solve(rows, y) {
	var n = rows[0].length, M = [], v = [];
	for (var i = 0; i < n; i++) { M.push(new Array(n).fill(0)); v.push(0); }
	for (var k = 0; k < rows.length; k++) for (var i = 0; i < n; i++) { v[i] += rows[k][i] * y[k]; for (var j = 0; j < n; j++) M[i][j] += rows[k][i] * rows[k][j]; }
	for (var i = 0; i < n; i++) {
		var piv = i; for (var r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
		var t = M[i]; M[i] = M[piv]; M[piv] = t; var tv = v[i]; v[i] = v[piv]; v[piv] = tv;
		var p = M[i][i]; for (var j = i; j < n; j++) M[i][j] /= p; v[i] /= p;
		for (var r = 0; r < n; r++) if (r !== i) { var q = M[r][i]; for (var j = i; j < n; j++) M[r][j] -= q * M[i][j]; v[r] -= q * v[i]; }
	}
	return v;
}

if (process.argv[1] && process.argv[1].endsWith("fitLevel0.mjs")) {
	var L = levelPlanes(openFile(process.argv[2]), 0);
	var ref = readTiff(new Uint8Array(fs.readFileSync(process.argv[3])));
	var terms = process.argv[4] === "all"
		? [[0, "LL"], [1, "LL"], [2, "LL"], [0, "LH"], [0, "HL"], [0, "HH"], [1, "LH"], [1, "HL"], [1, "HH"], [2, "LH"], [2, "HL"], [2, "HH"]]
		: [[0, "LL"], [1, "LL"], [2, "LL"]];
	var rows = [], ch = [[], [], []];
	for (var y = 0; y < ref.height; y++) for (var x = 0; x < ref.width; x++) {
		var li = y * L.width + x, ri = (y * ref.width + x) * 3;
		rows.push(terms.map(function (t) { return L.planes[t[0]][t[1]][li]; }).concat([1]));
		for (var c = 0; c < 3; c++) ch[c].push(ref.data[ri + c]);
	}
	["R", "G", "B"].forEach(function (name, c) {
		var coef = solve(rows, ch[c]);
		var err = 0, maxe = 0;
		rows.forEach(function (r, k) { var p = 0; for (var i = 0; i < r.length; i++) p += coef[i] * r[i]; var e = Math.abs(p - ch[c][k]); err += e; if (e > maxe) maxe = e; });
		console.log(name, terms.map(function (t, i) { return t[0] + t[1] + ":" + coef[i].toFixed(3); }).join(" "), "c:" + coef[terms.length].toFixed(2), "mean|err| " + (err / rows.length).toFixed(3), "max " + maxe.toFixed(1));
	});
}
