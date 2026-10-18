// _dev/ecw-decode/headerSweep.mjs
//==========================================================
// Black-box meaning of unknown header bytes: crafts a small file,
// patches one header byte through a range of values, and records
// what gdalinfo (ECW SDK) reports for each, or that it refuses it.
// Run: node _dev/ecw-decode/headerSweep.mjs <offset> <bands> [from] [to]
//==========================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { craftEcw } from "./craft.mjs";
import { findSample } from "../../test/helpers/samples.js";

var QGIS_BIN = process.env.QGIS_BIN || "C:\\Program Files\\QGIS 4.2.3\\bin";
var GDAL_APPS = path.join(QGIS_BIN, "..", "apps", "gdal");
var ENV = Object.assign({}, process.env, {
	PATH: QGIS_BIN + path.delimiter + process.env.PATH,
	GDAL_DRIVER_PATH: path.join(GDAL_APPS, "lib", "gdalplugins"),
	GDAL_DATA: path.join(GDAL_APPS, "share", "gdal")
});

var offset = Number(process.argv[2]), bands = Number(process.argv[3] || 1);
var from = Number(process.argv[4] || 0), to = Number(process.argv[5] || 7);
var base = craftEcw({ width: 128, height: 128, levelCount: 2, bands: bands, coeff: function (r, b, sb, x, y) { return sb === "LL" ? 100 + ((x + y) % 50) : 0; } });
var dir = path.join(path.dirname(findSample().ecwPath), "synth");
fs.mkdirSync(dir, { recursive: true });
for (var v = from; v <= to; v++) {
	var bytes = base.slice();
	bytes[offset] = v;
	var file = path.join(dir, "sweep-" + offset + "-" + bands + "-" + v + ".ecw");
	fs.writeFileSync(file, bytes);
	var r = spawnSync(path.join(QGIS_BIN, "gdalinfo.exe"), ["-json", file], { env: ENV, encoding: "utf8" });
	if (r.status !== 0) { console.log("0x" + offset.toString(16), "=", v, "->", "refused:", (r.stderr || "").trim().split("\n")[0]); continue; }
	var j = JSON.parse(r.stdout);
	var t = spawnSync(path.join(QGIS_BIN, "gdal_translate.exe"), ["-q", "-of", "GTiff", file, file + ".tif"], { env: ENV, encoding: "utf8" });
	console.log("0x" + offset.toString(16), "=", v, "->", JSON.stringify(j.metadata[""]), j.bands.map(function (b) { return b.colorInterpretation; }).join(","), "| decode", t.status === 0 ? "ok" : "fails: " + (t.stderr || "").trim().split("\n")[0]);
}
