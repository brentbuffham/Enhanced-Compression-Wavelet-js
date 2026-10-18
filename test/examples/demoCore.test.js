// test/examples/demoCore.test.js
//==========================================================
// Demo worker core over a synthetic ECW Blob
// (1000x600, 3 levels, grids 2x2 / 4x3 / 8x5, 56 blocks).
// Run with: node --test test/examples/demoCore.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openFile, readLevelBlockSizes, inspectBlock, sampleModes, levelPictureBounds } from "../../examples/browser/lib/demoCore.js";
import { buildEcwFile } from "../helpers/buildEcwFile.js";

// A framed block: (count - 1) u32 BE offsets then streams [[mode, ...payload]]
function frame(streams) {
	var header = (streams.length - 1) * 4;
	var total = header + streams.reduce(function (s, st) { return s + st.length; }, 0);
	var out = new Uint8Array(total);
	var view = new DataView(out.buffer);
	var rel = 0;
	streams.forEach(function (st, i) {
		if (i > 0) view.setUint32((i - 1) * 4, rel, false);
		out.set(st, header + rel);
		rel += st.length;
	});
	return out;
}

function makeBlocks() {
	var blocks = [];
	for (var n = 0; n < 56; n++) {
		var count = n < 4 ? 12 : 9;
		var streams = Array.from({ length: count }, function () { return [5]; });
		streams[0] = n % 2 ? [2, 1, 2, 3] : [6, 9];
		blocks.push(frame(streams));
	}
	return blocks;
}

var BLOCKS = makeBlocks();
var BLOB = new Blob([buildEcwFile({ blocks: BLOCKS })]);

test("openFile returns info, index, grid and headline stats", async function () {
	var calls = [];
	var f = await openFile(BLOB, function (fraction, label) { calls.push([fraction, label]); });
	assert.equal(f.info.width, 1000);
	assert.equal(f.grid.length, 3);
	assert.equal(f.fileSize, BLOB.size);
	assert.equal(f.stats.blockCount, 56);
	assert.equal(f.stats.compressionRatio, 1000 * 600 * 3 / BLOB.size);
	assert.deepEqual(calls.at(-1), [1, "header and block index read"]);
});

test("readLevelBlockSizes returns each block's byte length", async function () {
	var f = await openFile(BLOB, function () {});
	var level = await readLevelBlockSizes(BLOB, f.index, f.grid, 1, function () {});
	assert.equal(level.cols, 4);
	assert.equal(level.rows, 3);
	assert.deepEqual(Array.from(level.sizes), BLOCKS.slice(4, 16).map(function (b) { return b.length; }));
});

test("inspectBlock frames one block", async function () {
	var f = await openFile(BLOB, function () {});
	var b = await inspectBlock(BLOB, f.index, f.grid, f.info, 5);
	assert.deepEqual({ n: b.n, level: b.level, row: b.row, col: b.col }, { n: 5, level: 1, row: 0, col: 1 });
	assert.equal(b.end - b.start, BLOCKS[5].length);
	assert.equal(b.streams.length, 9);
	assert.deepEqual(b.streams[0], { band: 0, subband: "LH", mode: 2, length: 4 });
	assert.deepEqual(b.streams[1], { band: 0, subband: "HL", mode: 5, length: 1 });
});

test("sampleModes tallies stream modes over evenly spaced blocks", async function () {
	var f = await openFile(BLOB, function () {});
	var s = await sampleModes(BLOB, f.index, f.grid, f.info, 2, 10, function () {});
	assert.equal(s.sampled, 10);
	assert.equal(s.modes[2] + s.modes[6], 10);
	assert.equal(s.modes[5], 80);
	assert.equal(s.emptyShare, 80 / 90);
});

test("sampleModes never samples more blocks than the level has", async function () {
	var f = await openFile(BLOB, function () {});
	assert.equal((await sampleModes(BLOB, f.index, f.grid, f.info, 0, 100, function () {})).sampled, 4);
});

test("levelPictureBounds covers whole blocks at that level", async function () {
	var f = await openFile(BLOB, function () {});
	// level 0 of 3: one level pixel = 8 full pixels; 2x2 blocks of 64 = 1024x1024 full pixels
	assert.deepEqual(levelPictureBounds(f.info, f.header, f.grid[0]), { minX: 1000.25, minY: 5000.75 - 512, maxX: 1000.25 + 512, maxY: 5000.75 });
});
