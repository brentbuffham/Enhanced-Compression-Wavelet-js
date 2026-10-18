// test/samples/header.sample.test.js
//==========================================================
// Header and level table against gdalinfo on a private sample.
// Skips when samples/*.ecw or samples/ref/gdalinfo.json is missing.
// Expected values are read at runtime; none are written here.
// Run with: node --test test/samples/header.sample.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels, expectedLevelDimensions } from "../../src/format/EcwLevels.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { findSample, readRange } from "../helpers/samples.js";

var sample = findSample();
var skip = sample ? false : "no samples/*.ecw with samples/ref/gdalinfo.json";

function load() {
	var source = new MemorySource(readRange(sample.ecwPath, 0, 8192));
	return { source: source, header: parseHeader(source) };
}

test("header matches gdalinfo", { skip: skip }, function () {
	var info = JSON.parse(readFileSync(join(sample.refDir, "gdalinfo.json"), "utf8"));
	var h = load().header;
	assert.deepEqual([h.width, h.height], info.size);
	assert.equal(h.bands, info.bands.length);
	// GDAL tidies the stored doubles (values stored one ULP off a round number); we keep the raw value
	[h.originX, h.cellSizeX, 0, h.originY, 0, h.cellSizeY].forEach(function (v, i) {
		assert.ok(Math.abs(v - info.geoTransform[i]) < 1e-9, "geoTransform[" + i + "] " + v + " vs " + info.geoTransform[i]);
	});
	assert.equal(String(h.version), info.metadata[""].VERSION);
	assert.equal(String(h.compressionTarget), info.metadata[""].COMPRESSION_RATE_TARGET);
});

test("every level record matches the ceil rule; finest is ceil(full / 2)", { skip: skip }, function () {
	var loaded = load();
	var h = loaded.header;
	var levels = parseLevels(loaded.source, h).map(function (l) { return { width: l.width, height: l.height }; });
	assert.deepEqual(levels, expectedLevelDimensions(h.width, h.height, h.levelCount));
	assert.deepEqual(levels.at(-1), { width: Math.ceil(h.width / 2), height: Math.ceil(h.height / 2) });
});
