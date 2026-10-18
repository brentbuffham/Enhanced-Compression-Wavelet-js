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
//   crop-origin.tif               256x256 full-res at (0,0)
//   crop-aligned.tif              512x512 full-res at the 64-aligned point nearest the centre
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

// Step 4) Full-resolution crops
var cx = Math.floor(header.width / 2 / 64) * 64;
var cy = Math.floor(header.height / 2 / 64) * 64;
translate("crop-origin.tif", [0, 0, 256, 256], [256, 256]);
translate("crop-aligned.tif", [cx, cy, 512, 512], [512, 512]);
translate("crop-straddle.tif", [cx + 37, cy + 37, 300, 300], [300, 300]);

fs.writeFileSync(path.join(refDir, "manifest.json"), JSON.stringify(manifest, null, "\t"));
console.log("wrote " + manifest.length + " references to " + refDir);
