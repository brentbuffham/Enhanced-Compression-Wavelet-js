// test/samples/readRegion.sample.test.js
//==========================================================
// readRegion against the GDAL reference set on the private sample.
// Current state (FINDINGS.md "the last ±1"): every value within 4 of
// GDAL and at least 20% identical (overviews ~70-78%, full resolution ~24%). Tighten to exact once the SDK's
// final colour rounding is reproduced.
// Level-0 reference is skipped: GDAL's coarsest overview is the level-1
// reconstruction sampled at even pixels, not record 0's LL.
// Skips without samples. Run with: node --test test/samples/readRegion.sample.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, openAsBlob } from "node:fs";
import { join } from "node:path";
import { openEcw } from "../../src/EcwReader.js";
import { readTiff } from "../helpers/readTiff.js";
import { findSample } from "../helpers/samples.js";

var sample = findSample();
var manifestPath = sample && join(sample.refDir, "manifest.json");
var skip = sample && existsSync(manifestPath) ? false : "no samples/ref/manifest.json";
var MAX_ERROR = 4;
var MIN_EXACT = 0.20;

function compare(img, ref) {
	var exact = 0, max = 0, n = 0;
	for (var i = 0; i < ref.width * ref.height; i++) {
		for (var c = 0; c < 3; c++) {
			var d = Math.abs(img.data[i * 4 + c] - ref.data[i * 3 + c]);
			if (d === 0) exact++;
			if (d > max) max = d;
			n++;
		}
	}
	return { exact: exact / n, max: max };
}

test("readRegion matches GDAL references within tolerance", { skip: skip, timeout: 120000 }, async function () {
	var ecw = await openEcw(await openAsBlob(sample.ecwPath));
	var manifest = JSON.parse(readFileSync(manifestPath, "utf8")).filter(function (m) { return m.name !== "level-0.tif"; });
	for (var m of manifest) {
		var ref = readTiff(new Uint8Array(readFileSync(join(sample.refDir, m.name))));
		var img = await ecw.readRegion({ x: m.srcwin[0], y: m.srcwin[1], width: m.srcwin[2], height: m.srcwin[3], outWidth: m.outsize[0], outHeight: m.outsize[1] });
		var r = compare(img, ref);
		assert.ok(r.max <= MAX_ERROR, m.name + ": max error " + r.max);
		assert.ok(r.exact >= MIN_EXACT, m.name + ": exact " + (100 * r.exact).toFixed(1) + "%");
		console.log("# " + m.name + " level " + img.level + " exact " + (100 * r.exact).toFixed(1) + "% max " + r.max);
	}
});
