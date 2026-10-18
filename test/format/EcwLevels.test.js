// test/format/EcwLevels.test.js
//==========================================================
// Level table from 0x59, coarsest first: records of 9 + 4 x bands
// bytes (index, width, height, one dequantisation step per band).
// Run with: node --test test/format/EcwLevels.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLevels, levelTableEnd, expectedLevelDimensions } from "../../src/format/EcwLevels.js";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { buildEcwHeader } from "../helpers/buildEcwHeader.js";

function defaultLevels() {
	return [
		{ level: 0, width: 125, height: 75, steps: [1, 1, 1], a: 1, b: 1, c: 1 },
		{ level: 1, width: 250, height: 150, steps: [1, 1, 1], a: 1, b: 1, c: 1 },
		{ level: 2, width: 500, height: 300, steps: [1, 1, 1], a: 1, b: 1, c: 1 }
	];
}

function levelsOf(overrides) {
	var s = new MemorySource(buildEcwHeader(overrides));
	return parseLevels(s, parseHeader(s));
}

test("expectedLevelDimensions follows the ceil rule", function () {
	assert.deepEqual(expectedLevelDimensions(100001, 50001, 10)[0], { width: 98, height: 49 });
	assert.deepEqual(expectedLevelDimensions(100001, 50001, 10)[9], { width: 50001, height: 25001 });
	assert.deepEqual(expectedLevelDimensions(1000, 600, 3), [{ width: 125, height: 75 }, { width: 250, height: 150 }, { width: 500, height: 300 }]);
});

test("parses synthetic level records", function () {
	var s = new MemorySource(buildEcwHeader({}));
	var h = parseHeader(s);
	assert.equal(levelTableEnd(h), 0x59 + 63);
	assert.deepEqual(parseLevels(s, h), defaultLevels());
});

test("a, b, c values are read as stored", function () {
	var lv = defaultLevels();
	lv[2] = { level: 2, width: 500, height: 300, steps: [8, 24, 24], a: 8, b: 24, c: 24 };
	assert.deepEqual(levelsOf({ levels: lv })[2], lv[2]);
});

test("a single-band record is 13 bytes with one step", function () {
	var levels = [{ level: 0, width: 125, height: 75, steps: [1] }, { level: 1, width: 250, height: 150, steps: [3] }, { level: 2, width: 500, height: 300, steps: [7] }];
	var s = new MemorySource(buildEcwHeader({ bands: 1, levels: levels, colorSpace: 1 }));
	var h = parseHeader(s);
	var parsed = parseLevels(s, h);
	assert.deepEqual(parsed.map(function (l) { return [l.width, l.height, l.steps]; }), [[125, 75, [1]], [250, 150, [3]], [500, 300, [7]]]);
	assert.equal(parsed[2].a, 7);
	assert.equal(levelTableEnd(h), 0x59 + 3 * 13);
});

test("a five-band record holds five steps", function () {
	var levels = [0, 1, 2].map(function (k) { return { level: k, width: [125, 250, 500][k], height: [75, 150, 300][k], steps: [k + 1, k + 2, k + 3, k + 4, k + 5] }; });
	var s = new MemorySource(buildEcwHeader({ bands: 5, levels: levels, colorSpace: 3 }));
	var h = parseHeader(s);
	assert.deepEqual(parseLevels(s, h)[2].steps, [3, 4, 5, 6, 7]);
	assert.equal(levelTableEnd(h), 0x59 + 3 * 29);
});

test("levelCount 0 throws BAD_LEVEL_TABLE at 0x04", function () {
	assert.throws(function () { levelsOf({ levelCount: 0, levels: [] }); }, { code: "BAD_LEVEL_TABLE", offset: 0x04 });
});

test("out-of-order level byte throws at that record", function () {
	var lv = defaultLevels(); lv[1].level = 5;
	assert.throws(function () { levelsOf({ levels: lv }); }, { code: "BAD_LEVEL_TABLE", offset: 0x59 + 21 });
});

test("zero-sized level throws at that record", function () {
	var lv = defaultLevels(); lv[0].height = 0;
	assert.throws(function () { levelsOf({ levels: lv }); }, { code: "BAD_LEVEL_TABLE", offset: 0x59 });
});

test("shrinking size throws at that record", function () {
	var lv = defaultLevels(); lv[2].width = 249;
	assert.throws(function () { levelsOf({ levels: lv }); }, { code: "BAD_LEVEL_TABLE", offset: 0x59 + 42 });
});

test("equal sizes at coarse levels are allowed (thin strip images)", function () {
	var lv = expectedLevelDimensions(1000, 10, 6).map(function (d, i) { return { level: i, width: d.width, height: d.height, steps: [1, 1, 1], a: 1, b: 1, c: 1 }; });
	assert.equal(lv[0].height, lv[1].height);
	assert.deepEqual(levelsOf({ width: 1000, height: 10, levelCount: 6, levels: lv }), lv);
});

test("level larger than full size throws", function () {
	var lv = defaultLevels(); lv[2].width = 1001;
	assert.throws(function () { levelsOf({ levels: lv }); }, { code: "BAD_LEVEL_TABLE", offset: 0x59 + 42 });
});

test("truncated table throws TRUNCATED at table end", function () {
	assert.throws(function () { levelsOf({ truncateAt: 0x59 + 30 }); }, { code: "TRUNCATED", offset: 0x59 + 63 });
});
