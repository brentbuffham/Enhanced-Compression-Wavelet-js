// _dev/ecw-decode/makeRefs.mjs
//==========================================================
// Builds the black-box reference set for a sample ECW using
// QGIS's bundled GDAL (ECW SDK). Output goes to samples/ref/,
// which is gitignored; nothing here is ever committed.
//
// Usage: node _dev/ecw-decode/makeRefs.mjs <file.ecw>
// Env:   QGIS_BIN (default C:\Program Files\QGIS 4.2.3\bin)
//
// Writes:
//   gdalinfo.json                 gdalinfo -json
//   level-<k>.tif                 one per stored level, whole level cells only
//                                 (srcwin = cols*s x rows*s, outsize = cols x rows,
//                                 s = 2^(levelCount-k)) so pixels sit on the level grid.
//                                 Levels above MAX_LEVEL_PIXELS are skipped.
//   full.tif                      the whole image at full resolution, when it fits the budget
//   crop-origin.tif               256x256 full-res at (0,0)
//   crop-aligned.tif              512x512 full-res, 64-aligned, inside the imagery (not background)
//   crop-straddle.tif             300x300 full-res at that point + 37 (crosses block edges)
//   manifest.json                 every output with its srcwin and outsize
//==========================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels } from "../../src/format/EcwLevels.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { readFileRange } from "./probeLib.mjs";
import { readTiff } from "../../test/helpers/readTiff.js";

// About 48 MB of RGB per reference TIFF; finer levels are covered by the crops
var MAX_LEVEL_PIXELS = 16 * 1024 * 1024;

var ecwPath = process.argv[2];
if (!ecwPath) {
	console.error("usage: makeRefs.mjs <file.ecw>");
	process.exit(2);
}

var qgisBin = process.env.QGIS_BIN || "C:\\Program Files\\QGIS 4.2.3\\bin";
var gdalApps = path.join(qgisBin, "..", "apps", "gdal");
var env = Object.assign({}, process.env, {
	PATH: qgisBin + path.delimiter + process.env.PATH,
	GDAL_DRIVER_PATH: path.join(gdalApps, "lib", "gdalplugins"),
	GDAL_DATA: path.join(gdalApps, "share", "gdal")
});

function run(tool, args) {
	var result = spawnSync(path.join(qgisBin, tool), args, { env: env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.status !== 0) {
		throw new Error(tool + " failed: " + (result.stderr || result.error));
	}
	return result.stdout;
}

var refDir = path.join(path.dirname(path.resolve(ecwPath)), "ref");
fs.mkdirSync(refDir, { recursive: true });

// Step 1) gdalinfo
fs.writeFileSync(path.join(refDir, "gdalinfo.json"), run("gdalinfo.exe", ["-json", ecwPath]));

// Step 2) Header and levels from our own parser
var source = new MemorySource(readFileRange(fs, ecwPath, 0, 8192));
var header = parseHeader(source);
var levels = parseLevels(source, header);
var manifest = [];

function translate(name, srcwin, outsize) {
	run("gdal_translate.exe", ["-q", "-of", "GTiff", "-co", "COMPRESS=NONE", "-co", "INTERLEAVE=PIXEL",
		"-srcwin"].concat(srcwin.map(String), ["-outsize"], outsize.map(String), [ecwPath, path.join(refDir, name)]));
	manifest.push({ name: name, srcwin: srcwin, outsize: outsize });
	console.log(name + "  srcwin " + srcwin.join(" ") + "  outsize " + outsize.join("x"));
}

// Step 3) One reference per stored level, aligned to whole level cells
levels.forEach(function (level, k) {
	var s = Math.pow(2, header.levelCount - k);
	var cols = Math.floor(header.width / s);
	var rows = Math.floor(header.height / s);
	if (cols * rows > MAX_LEVEL_PIXELS) {
		console.log("level-" + k + ".tif  skipped (" + cols + "x" + rows + " over budget)");
		return;
	}
	translate("level-" + k + ".tif", [0, 0, cols * s, rows * s], [cols, rows]);
});

// Small files: the whole image at full resolution too
if (header.width * header.height <= MAX_LEVEL_PIXELS) translate("full.tif", [0, 0, header.width, header.height], [header.width, header.height]);

// Step 4) Full-resolution crops, placed inside the imagery: find the non-black
// point of the finest level reference nearest the imagery centroid (crops are
// clipped to the image, and fall back to its centre when nothing is solid enough)
var finest = manifest[manifest.length - 1];
var lref = readTiff(new Uint8Array(fs.readFileSync(path.join(refDir, finest.name))));
var lscale = finest.srcwin[2] / finest.outsize[0];
function solid(x, y, r) {
	for (var j = -r; j <= r; j++) for (var i = -r; i <= r; i++) {
		var xx = x + i, yy = y + j;
		if (xx < 0 || yy < 0 || xx >= lref.width || yy >= lref.height) return false;
		var k = (yy * lref.width + xx) * 3;
		if (lref.data[k] + lref.data[k + 1] + lref.data[k + 2] <= 6) return false;
	}
	return true;
}
var sx = 0, sy = 0, cnt = 0;
for (var yy = 0; yy < lref.height; yy++) for (var xx = 0; xx < lref.width; xx++) {
	var k0 = (yy * lref.width + xx) * 3;
	if (lref.data[k0] + lref.data[k0 + 1] + lref.data[k0 + 2] > 6) { sx += xx; sy += yy; cnt++; }
}
var radius = Math.min(Math.ceil(600 / lscale), Math.floor(Math.min(lref.width, lref.height) / 4));
var best = null;
for (yy = 0; yy < lref.height; yy++) for (xx = 0; xx < lref.width; xx++) {
	var d = (xx - sx / cnt) * (xx - sx / cnt) + (yy - sy / cnt) * (yy - sy / cnt);
	if ((!best || d < best.d) && solid(xx, yy, radius)) best = { x: xx, y: yy, d: d };
}
if (!best) best = { x: Math.floor(lref.width / 2), y: Math.floor(lref.height / 2) };
// a crop of size n at (x, y), moved and shrunk to fit inside the image
function crop(name, x, y, n) {
	var w = Math.min(n, header.width), h = Math.min(n, header.height);
	x = Math.max(0, Math.min(x, header.width - w));
	y = Math.max(0, Math.min(y, header.height - h));
	translate(name, [x, y, w, h], [w, h]);
}
var cx = Math.floor(best.x * lscale / 64) * 64;
var cy = Math.floor(best.y * lscale / 64) * 64;
crop("crop-origin.tif", 0, 0, 256);
crop("crop-aligned.tif", cx, cy, 512);
crop("crop-straddle.tif", cx + 37, cy + 37, 300);

fs.writeFileSync(path.join(refDir, "manifest.json"), JSON.stringify(manifest, null, "\t"));
console.log("wrote " + manifest.length + " references to " + refDir);
