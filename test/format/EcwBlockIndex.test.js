// test/format/EcwBlockIndex.test.js
//==========================================================
// Block index: grid, entry windows and block byte ranges.
// Synthetic 1000x600, 3 levels, 64-px blocks:
// level grids 2x2, 4x3, 8x5 -> 4 + 12 + 40 = 56 blocks, 57 entries.
// Run with: node --test test/format/EcwBlockIndex.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlockIndex, blockGrid, totalBlocks, blockNumber, blockEntryWindow, levelEntryWindow, blockByteRange, checkBlockIndex } from "../../src/format/EcwBlockIndex.js";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels } from "../../src/format/EcwLevels.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { buildEcwFile, numberedBlocks } from "../helpers/buildEcwFile.js";

var HEADER_END = 0x59 + 63;

function open(o) {
	var bytes = buildEcwFile(o);
	var source = new MemorySource(bytes);
	var header = parseHeader(source);
	var levels = parseLevels(source, header);
	return { bytes: bytes, header: header, levels: levels, index: parseBlockIndex(source, header), grid: blockGrid(header, levels) };
}

test("parseBlockIndex fields", function () {
	var f = open({ blocks: numberedBlocks(56) });
	assert.deepEqual(f.index, { indexOffset: HEADER_END, bodyLength: 1 + 8 * 57, flag: 1, entryCount: 57,
		offsetsStart: HEADER_END + 5, dataStart: HEADER_END + 4 + 1 + 8 * 57 });
});

test("blockGrid and totalBlocks", function () {
	var f = open({ blocks: numberedBlocks(56) });
	assert.deepEqual(f.grid, [
		{ level: 0, cols: 2, rows: 2, firstBlock: 0 },
		{ level: 1, cols: 4, rows: 3, firstBlock: 4 },
		{ level: 2, cols: 8, rows: 5, firstBlock: 16 }
	]);
	assert.equal(totalBlocks(f.grid), 56);
	checkBlockIndex(f.index, f.grid);
});

test("1-px edge row adds a block row", function () {
	// level 0 of 1000x520 over 3 levels is 125x65 -> 2 block rows
	var f = open({ headerOverrides: { width: 1000, height: 520 }, entries: [0] });
	assert.equal(f.grid[0].rows, 2);
});

test("blockNumber is row-major within a level", function () {
	var grid = open({ blocks: numberedBlocks(56) }).grid;
	assert.equal(blockNumber(grid, 1, 2, 3), 4 + 2 * 4 + 3);
	assert.equal(blockNumber(grid, 0, 0, 0), 0);
	assert.throws(function () { blockNumber(grid, 1, 3, 0); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { blockNumber(grid, 3, 0, 0); }, { code: "INVALID_ARGUMENT" });
});

test("blockByteRange returns every block's exact bytes; last ends at file end", function () {
	var f = open({ blocks: numberedBlocks(56) });
	for (var n = 0; n < 56; n++) {
		var w = blockEntryWindow(f.index, n);
		assert.equal(w.end - w.start, 16);
		var r = blockByteRange(f.index, n, f.bytes.subarray(w.start, w.end), f.bytes.length);
		var block = f.bytes.subarray(r.start, r.end);
		assert.equal(block.length, n + 1);
		assert.ok(block.every(function (b) { return b === n; }));
		if (n === 55) assert.equal(r.end, f.bytes.length);
	}
});

test("levelEntryWindow covers a level's entries plus the next one", function () {
	var f = open({ blocks: numberedBlocks(56) });
	assert.deepEqual(levelEntryWindow(f.index, f.grid[1]), { start: f.index.offsetsStart + 8 * 4, end: f.index.offsetsStart + 8 * 17 });
});

test("blockEntryWindow rejects out-of-range block numbers", function () {
	var f = open({ blocks: numberedBlocks(56) });
	assert.throws(function () { blockEntryWindow(f.index, 56); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { blockEntryWindow(f.index, -1); }, { code: "INVALID_ARGUMENT" });
});

test("falling offset throws BAD_BLOCK_INDEX at the second entry", function () {
	var f = open({ entries: [10, 5] });
	var w = blockEntryWindow(f.index, 0);
	assert.throws(function () { blockByteRange(f.index, 0, f.bytes.subarray(w.start, w.end), 1e9); }, { code: "BAD_BLOCK_INDEX", offset: w.start + 8 });
});

test("block end past the file throws TRUNCATED", function () {
	var f = open({ entries: [0, 100] });
	var w = blockEntryWindow(f.index, 0);
	assert.throws(function () { blockByteRange(f.index, 0, f.bytes.subarray(w.start, w.end), f.bytes.length); }, { code: "TRUNCATED", offset: f.index.dataStart + 100 });
});

test("offsets above 2^32 read exactly", function () {
	var f = open({ entries: [0, 0x100000010] });
	var w = blockEntryWindow(f.index, 0);
	var r = blockByteRange(f.index, 0, f.bytes.subarray(w.start, w.end), 1e12);
	assert.equal(r.end - r.start, 4294967312);
});

test("an entry past 2^53 throws BAD_BLOCK_INDEX, never silent arithmetic", function () {
	var f = open({ entries: [0, 0] });
	var w = blockEntryWindow(f.index, 0);
	var bytes = f.bytes.slice(w.start, w.end);
	bytes.fill(0xFF, 8, 16);
	assert.throws(function () { blockByteRange(f.index, 0, bytes, 1e18); }, { code: "BAD_BLOCK_INDEX", offset: w.start + 8 });
});

test("entry count that disagrees with the grid throws BAD_BLOCK_INDEX", function () {
	var f = open({ blocks: numberedBlocks(50) });
	assert.throws(function () { checkBlockIndex(f.index, f.grid); }, { code: "BAD_BLOCK_INDEX", offset: HEADER_END });
});

test("body length not 1 + 8k throws BAD_BLOCK_INDEX", function () {
	assert.throws(function () { open({ blocks: numberedBlocks(56), bodyLength: 1 + 8 * 57 + 3 }); }, { code: "BAD_BLOCK_INDEX", offset: HEADER_END });
});

test("file ending inside the index header throws TRUNCATED", function () {
	assert.throws(function () { open({ blocks: numberedBlocks(56), truncateAt: HEADER_END + 3 }); }, { code: "TRUNCATED", offset: HEADER_END + 5 });
});

test("zero block size throws BAD_BLOCK_INDEX at the header field", function () {
	assert.throws(function () { open({ headerOverrides: { blockWidth: 0 }, entries: [0] }); }, { code: "BAD_BLOCK_INDEX", offset: 0x12 });
	assert.throws(function () { open({ headerOverrides: { blockHeight: 0 }, entries: [0] }); }, { code: "BAD_BLOCK_INDEX", offset: 0x14 });
});
