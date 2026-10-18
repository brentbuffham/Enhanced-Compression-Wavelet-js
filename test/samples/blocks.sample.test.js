// test/samples/blocks.sample.test.js
//==========================================================
// Block index and framing on the private sample: the index
// matches the level grid, the end marker lands on the file size,
// and 2,000 evenly spaced blocks frame cleanly with known modes.
// Skips without samples. Run with: node --test test/samples/blocks.sample.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels } from "../../src/format/EcwLevels.js";
import { parseBlockIndex, blockGrid, checkBlockIndex, totalBlocks, blockEntryWindow, blockByteRange } from "../../src/format/EcwBlockIndex.js";
import { splitBlockStreams } from "../../src/format/EcwBlockFrame.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { findSample, readRange } from "../helpers/samples.js";

var sample = findSample();
var skip = sample ? false : "no samples/*.ecw with samples/ref/gdalinfo.json";

function load() {
	var source = new MemorySource(readRange(sample.ecwPath, 0, 8192));
	var header = parseHeader(source);
	var levels = parseLevels(source, header);
	return { header: header, index: parseBlockIndex(source, header), grid: blockGrid(header, levels), size: statSync(sample.ecwPath).size };
}

test("block index matches the level grid and ends at the file size", { skip: skip }, function () {
	var f = load();
	checkBlockIndex(f.index, f.grid);
	var last = totalBlocks(f.grid) - 1;
	var w = blockEntryWindow(f.index, last);
	var r = blockByteRange(f.index, last, readRange(sample.ecwPath, w.start, 16), f.size);
	assert.equal(r.end, f.size);
});

test("2,000 evenly spaced blocks frame cleanly with modes 2, 5 or 6", { skip: skip }, function () {
	var f = load();
	var total = totalBlocks(f.grid);
	var modes = {};
	for (var i = 0; i < 2000; i++) {
		var n = Math.floor(i * total / 2000);
		var level = f.grid.findIndex(function (g) { return n < g.firstBlock + g.cols * g.rows; });
		var w = blockEntryWindow(f.index, n);
		var r = blockByteRange(f.index, n, readRange(sample.ecwPath, w.start, 16), f.size);
		var streams = splitBlockStreams(readRange(sample.ecwPath, r.start, r.end - r.start), f.header.bands, level);
		streams.forEach(function (s) { modes[s.mode] = (modes[s.mode] || 0) + 1; });
	}
	assert.deepEqual(Object.keys(modes).map(Number).sort(), [2, 5, 6]);
});
