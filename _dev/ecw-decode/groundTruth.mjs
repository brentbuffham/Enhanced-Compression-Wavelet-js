// _dev/ecw-decode/groundTruth.mjs
//==========================================================
// Recovers the true coefficients of one luma stream that ecw-js
// cannot decode yet, from the reference decoder's pixels (QGIS GDAL as
// a black box: file in, pixels out). Every other coefficient around
// the block is decoded by ecw-js, so the unknown plane is the only
// free part of the synthesis:
//   1. GDAL renders the next image level over the block, aligned to
//      level cells (as in makeRefs.mjs).
//   2. Luma adds equally to R, G and B, so floor(Y) of each unclamped
//      pixel follows from GDAL's RGB and ecw-js's chroma.
//   3. Each unknown coefficient's effect on Y is measured by impulse,
//      the integers are solved by least squares, then nudged until the
//      synthesis reproduces GDAL's pixels exactly.
// Output: JSON with the plane (row-major, pw * ph, pre-dequantisation
// integers, i.e. what the stream codes). Keep outputs in samples/.
// Usage: node _dev/ecw-decode/groundTruth.mjs <file.ecw> <block> <stream> <out.json>
//==========================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openAsBlob } from "node:fs";
import { openEcw } from "../../src/EcwReader.js";
import { createDecodeContext, decodeWindow, imageLevelSize } from "../../src/decode/RegionDecoder.js";
import { blockRunEntryWindow, blockRunByteRanges } from "../../src/format/EcwBlockIndex.js";
import { colourTables } from "../../src/codec/colour.js";
import { readTiff } from "../../test/helpers/readTiff.js";

var args = process.argv.slice(2);
if (args.length < 4) { console.error("usage: groundTruth.mjs <file.ecw> <block> <stream> <out.json>"); process.exit(2); }
var file = args[0], blockN = Number(args[1]), streamK = Number(args[2]), outPath = args[3];

var qgisBin = process.env.QGIS_BIN || "C:\\Program Files\\QGIS 4.2.3\\bin";
var gdalApps = path.join(qgisBin, "..", "apps", "gdal");
var env = Object.assign({}, process.env, { PATH: qgisBin + path.delimiter + process.env.PATH,
	GDAL_DRIVER_PATH: path.join(gdalApps, "lib", "gdalplugins"), GDAL_DATA: path.join(gdalApps, "share", "gdal") });

var reader = await openEcw(await openAsBlob(file), { threads: 1, cache: false });
reader._ensureIndex();
var h = reader._header, levels = reader._levels, grid = reader._grid, index = reader._index, blob = reader._blobSource;
var record = grid.findIndex(function (g) { return blockN < g.firstBlock + g.cols * g.rows; });
var g = grid[record], local = blockN - g.firstBlock, row = Math.floor(local / g.cols), col = local % g.cols;
var lv = levels[record];
var pw = Math.min(h.blockWidth, lv.width - col * h.blockWidth), ph = Math.min(h.blockHeight, lv.height - row * h.blockHeight);
var per = record === 0 ? 4 : 3, subband = (record === 0 ? ["LL", "LH", "HL", "HH"] : ["LH", "HL", "HH"])[streamK % per], band = Math.floor(streamK / per);
if (band !== 0) throw new Error("only luma (band 0) streams are supported");
console.log("block " + blockN + ": record " + record + " row " + row + " col " + col + " extent " + pw + "x" + ph + ", stream " + streamK + " = b0 " + subband);

// Step 1) Window of image level j = record + 1 around the block, whole level cells only
var j = record + 1, s = Math.pow(2, h.levelCount - j), size = imageLevelSize(h, levels, j);
var maxX = Math.min(size.width, Math.floor(h.width / s)), maxY = Math.min(size.height, Math.floor(h.height / s));
var M = 6;
var x0 = Math.max(0, 2 * col * h.blockWidth - M), x1 = Math.min(maxX, 2 * (col * h.blockWidth + pw) + M);
var y0 = Math.max(0, 2 * row * h.blockHeight - M), y1 = Math.min(maxY, 2 * (row * h.blockHeight + ph) + M);
var W = x1 - x0, H = y1 - y0;
console.log("level " + j + " window x " + x0 + ".." + x1 + " y " + y0 + ".." + y1 + " (" + W + "x" + H + "), GDAL scale 1/" + s);

var tif = path.join(path.dirname(path.resolve(outPath)), "gt-" + blockN + "-" + streamK + ".tif");
var r = spawnSync(path.join(qgisBin, "gdal_translate.exe"), ["-q", "-of", "GTiff", "-co", "COMPRESS=NONE", "-co", "INTERLEAVE=PIXEL",
	"-srcwin", String(x0 * s), String(y0 * s), String(W * s), String(H * s), "-outsize", String(W), String(H), file, tif], { env: env, encoding: "utf8" });
if (r.status !== 0) throw new Error("gdal_translate failed: " + r.stderr);
var ref = readTiff(new Uint8Array(fs.readFileSync(tif)));
var refPx = ref.data || ref.pixels;

// Step 2) A decode context with the unknown stream skipped (read as empty)
var ctx = createDecodeContext({ header: h, levels: levels, index: index, grid: grid, onBadBlock: "skip",
	fetchBlocks: async function (n0, n1) {
		var w = blockRunEntryWindow(index, n0, n1);
		var ranges = blockRunByteRanges(index, n0, await blob.read(w.start, w.end), blob.size);
		var base = ranges[0].start, bytes = await blob.read(base, ranges[ranges.length - 1].end);
		return ranges.map(function (rr) { return bytes.subarray(rr.start - base, rr.end - base); });
	} });
var base0 = await decodeWindow(ctx, j, x0, y0, x1, y1);
var entry = ctx.blocks.get(blockN);
if (!entry) throw new Error("block not loaded by the window");
var key = "0" + subband, BIT = { LH: 1, HL: 2, HH: 4 }[subband];
entry.subbands[0] |= BIT;
async function lumaWith(plane) {
	entry.decoded[key] = plane;
	var win = await decodeWindow(ctx, j, x0, y0, x1, y1);
	return win.bands;
}
var zero = new Int32Array(pw * ph);
var Y0 = (await lumaWith(zero))[0];
var U = base0.bands[1], V = base0.bands[2];

// Target floor(Y) from GDAL RGB and our chroma (pixels where no channel clamps)
var T = colourTables();
var target = new Float64Array(W * H).fill(NaN);
for (var i = 0; i < W * H; i++) {
	var u = Math.floor(U[i]), v = Math.floor(V[i]);
	var R = refPx[i * 3], G = refPx[i * 3 + 1], B = refPx[i * 3 + 2];
	if (R <= 0 || R >= 255 || G <= 0 || G >= 255 || B <= 0 || B >= 255) continue;
	var yR = R - T.R(v), yG = G - T.GB(u) - T.GR(v), yB = B - T.B(u);
	if (yR === yG && yG === yB) target[i] = yR;
}
// Pixels that other skipped streams (still unknown) can reach say nothing about this one
var others = [];
ctx.bad.forEach(function (rec) {
	rec.streams.forEach(function (st) {
		if (rec.block === blockN && st.band === 0 && st.subband === subband) return;
		others.push({ e: ctx.blocks.get(rec.block), key: st.band + st.subband, bit: { LH: 1, HL: 2, HH: 4 }[st.subband], band: st.band });
	});
});
if (others.length) {
	others.forEach(function (o) {
		var rp = new Int32Array(o.e.pw * o.e.ph); for (var q = 0; q < rp.length; q++) rp[q] = 40 + (q * 7919) % 50;
		o.e.decoded[o.key] = rp; o.e.subbands[o.band] |= o.bit;
	});
	var Yp = (await lumaWith(zero))[0], dirty = 0;
	for (i = 0; i < W * H; i++) if (Yp[i] !== Y0[i] && !isNaN(target[i])) { target[i] = NaN; dirty++; }
	others.forEach(function (o) { o.e.decoded[o.key] = new Int32Array(o.e.pw * o.e.ph); o.e.subbands[o.band] &= ~o.bit; });
	console.log(others.length + " other skipped stream(s) in reach; excluded " + dirty + " pixels they affect");
}
var usable = 0; for (i = 0; i < W * H; i++) if (!isNaN(target[i])) usable++;
var baseMiss = 0; for (i = 0; i < W * H; i++) if (!isNaN(target[i]) && Math.floor(Y0[i]) !== target[i]) baseMiss++;
console.log(usable + " usable pixels; with the stream read as empty, " + baseMiss + " differ from GDAL");

// Step 3) Impulse responses (scaled, to stay above the eighths flooring)
var K = pw * ph, SCALE = 256, cols = [];
for (var c = 0; c < K; c++) {
	var p = new Int32Array(K); p[c] = SCALE;
	var Yc = (await lumaWith(p))[0];
	var col_ = new Float64Array(W * H);
	for (i = 0; i < W * H; i++) col_[i] = (Yc[i] - Y0[i]) / SCALE;
	cols.push(col_);
}
// Least squares on usable pixels: (A^T A + eps I) x = A^T (target + 0.5 - Y0)
var ATA = new Float64Array(K * K), ATb = new Float64Array(K);
var rows = []; for (i = 0; i < W * H; i++) if (!isNaN(target[i])) rows.push(i);
for (var a = 0; a < K; a++) {
	var ca = cols[a];
	for (var b = a; b < K; b++) { var cb = cols[b], sum = 0; for (var q = 0; q < rows.length; q++) sum += ca[rows[q]] * cb[rows[q]]; ATA[a * K + b] = ATA[b * K + a] = sum; }
	var sb = 0; for (q = 0; q < rows.length; q++) { var ii = rows[q]; sb += ca[ii] * (target[ii] + 0.5 - Y0[ii]); } ATb[a] = sb;
	ATA[a * K + a] += 1e-9;
}
function solve(A, bvec, n) {
	var m = Float64Array.from(A), x = Float64Array.from(bvec);
	for (var k = 0; k < n; k++) {
		var piv = k; for (var r2 = k + 1; r2 < n; r2++) if (Math.abs(m[r2 * n + k]) > Math.abs(m[piv * n + k])) piv = r2;
		if (piv !== k) { for (var c2 = 0; c2 < n; c2++) { var t = m[k * n + c2]; m[k * n + c2] = m[piv * n + c2]; m[piv * n + c2] = t; } var tx = x[k]; x[k] = x[piv]; x[piv] = tx; }
		var d = m[k * n + k]; if (Math.abs(d) < 1e-12) continue;
		for (r2 = k + 1; r2 < n; r2++) { var f = m[r2 * n + k] / d; if (!f) continue; for (c2 = k; c2 < n; c2++) m[r2 * n + c2] -= f * m[k * n + c2]; x[r2] -= f * x[k]; }
	}
	for (k = n - 1; k >= 0; k--) { var sum2 = x[k]; for (c2 = k + 1; c2 < n; c2++) sum2 -= m[k * n + c2] * x[c2]; x[k] = Math.abs(m[k * n + k]) < 1e-12 ? 0 : sum2 / m[k * n + k]; }
	return x;
}
var xf = solve(ATA, ATb, K);
var plane = new Int32Array(K); for (c = 0; c < K; c++) plane[c] = Math.round(xf[c]);

async function misses(pl) {
	var Y = (await lumaWith(pl))[0], n = 0;
	for (var q2 = 0; q2 < rows.length; q2++) { var i2 = rows[q2]; if (Math.floor(Y[i2]) !== target[i2]) n++; }
	return n;
}
var miss = await misses(plane);
console.log("least squares, rounded: " + miss + " pixels differ");
// Step 4) Nudge coefficients by +-1 while that lowers the mismatch count
for (var pass = 0; pass < 6 && miss > 0; pass++) {
	var improved = false;
	for (c = 0; c < K && miss > 0; c++) {
		for (var dlt of [1, -1]) {
			plane[c] += dlt;
			var m2 = await misses(plane);
			if (m2 < miss) { miss = m2; improved = true; break; }
			plane[c] -= dlt;
		}
	}
	console.log("pass " + (pass + 1) + ": " + miss + " pixels differ");
	if (!improved) break;
}
{ var Yf = (await lumaWith(plane))[0], byRow = new Map(), byCol = new Map();
	rows.forEach(function (ii) { if (Math.floor(Yf[ii]) !== target[ii]) { var ry = y0 + Math.floor(ii / W), rx = x0 + ii % W; byRow.set(ry, (byRow.get(ry) || 0) + 1); byCol.set(rx >> 4, (byCol.get(rx >> 4) || 0) + 1); } });
	if (miss) console.log("mismatches by level row: " + Array.from(byRow.entries()).sort().map(function (e) { return e.join(":"); }).join(" ") + " | by 16-px column group: " + Array.from(byCol.entries()).sort(function (a, b) { return a[0] - b[0]; }).map(function (e) { return (e[0] * 16) + ":" + e[1]; }).join(" ")); }
var weak = cols.map(function (cc, idx) { var e = 0; rows.forEach(function (ii) { e += cc[ii] * cc[ii]; }); return { idx: idx, e: e }; }).filter(function (o) { return o.e < 0.05; }).map(function (o) { return o.idx; });
var nz = 0, mean = 0; plane.forEach(function (v) { if (v) nz++; mean += Math.abs(v); });
console.log("plane: " + nz + "/" + K + " non-zero, mean |v| " + (mean / K).toFixed(1) + ", weakly observed coefficients: " + weak.length);
fs.writeFileSync(outPath, JSON.stringify({ block: blockN, record: record, row: row, col: col, pw: pw, ph: ph, stream: streamK, subband: subband,
	exact: miss === 0, mismatches: miss, weak: weak, plane: Array.from(plane) }));
console.log("wrote " + outPath);
