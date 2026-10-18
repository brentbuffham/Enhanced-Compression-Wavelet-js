// test/samples/refs.sample.test.js
//==========================================================
// Every GDAL reference in samples/ref/manifest.json reads back
// through readTiff at its outsize with 3 samples per pixel.
// Skips when the reference set is missing.
// Run with: node --test test/samples/refs.sample.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readTiff } from "../helpers/readTiff.js";
import { findSample } from "../helpers/samples.js";

var sample = findSample();
var hasManifest = sample && existsSync(join(sample.refDir, "manifest.json"));

test("every manifest reference decodes to its outsize with 3 samples per pixel", { skip: hasManifest ? false : "no samples/ref/manifest.json" }, function () {
	var manifest = JSON.parse(readFileSync(join(sample.refDir, "manifest.json"), "utf8"));
	assert.ok(manifest.length > 0);
	manifest.forEach(function (entry) {
		var t = readTiff(new Uint8Array(readFileSync(join(sample.refDir, entry.name))));
		assert.deepEqual([t.width, t.height, t.samplesPerPixel], [entry.outsize[0], entry.outsize[1], 3], entry.name);
	});
});
