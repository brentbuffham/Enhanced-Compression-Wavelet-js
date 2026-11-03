// test/readRegionBadBlocks.test.js
//==========================================================
// Blocks that can't be decoded: errors name the block (number,
// level, row, col, file offset); a stream in a mode the library
// doesn't decode raises UNSUPPORTED_MODE; onBadBlock: "skip" reads
// around them and lists them on the result. Synthetic files with one
// stream's mode byte (or stream table) patched.
// Run with: node --test test/readRegionBadBlocks.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openEcw } from "../src/EcwReader.js";
import { parseHeader } from "../src/format/EcwHeader.js";
import { parseLevels } from "../src/format/EcwLevels.js";
import { parseBlockIndex, blockGrid, blockNumber, blockEntryWindow, blockByteRange } from "../src/format/EcwBlockIndex.js";
import { MemorySource } from "../src/io/MemorySource.js";
import { buildCodedFile } from "./helpers/buildCodedFile.js";
import { createFakeRoot } from "./helpers/fakeOpfs.js";

// An arbitrary byte the library does not decode
var ODD = 0xEE;
var FULL = { x: 0, y: 0, width: 64, height: 48 };

// 64 x 48, 3 records (8x6, 16x12, 32x24), 4 px blocks; every stream coded (mode 6)
function build() {
	return buildCodedFile({ width: 64, height: 48, levelCount: 3, coeff: function (r, b, sb, x, y) {
		return sb === "LL" ? [60 + 5 * x + 2 * y, 3, -2][b] : ((x * y + r + b) % 7) - 3 || 1;
	} }).bytes;
}

// Block n's file range and the file offset of its stream k's mode byte
function locate(bytes, record, row, col, k) {
	var src = new MemorySource(bytes);
	var header = parseHeader(src);
	var index = parseBlockIndex(src, header);
	var grid = blockGrid(header, parseLevels(src, header));
	var n = blockNumber(grid, record, row, col);
	var w = blockEntryWindow(index, n);
	var range = blockByteRange(index, n, bytes.subarray(w.start, w.end), bytes.length);
	var view = new DataView(bytes.buffer, bytes.byteOffset);
	var count = header.bands * (record === 0 ? 4 : 3);
	var rel = k === 0 ? 0 : view.getUint32(range.start + (k - 1) * 4, false);
	return { n: n, start: range.start, end: range.end, mode: range.start + (count - 1) * 4 + rel };
}

test("throw (default): an undecoded mode raises UNSUPPORTED_MODE naming the block and asking for a sample", async function () {
	var bytes = build();
	var at = locate(bytes, 2, 3, 5, 1);
	bytes[at.mode] = ODD;
	var r = await openEcw(new Blob([bytes]), { threads: 1 });
	await assert.rejects(r.readRegion(FULL), function (err) {
		assert.equal(err.code, "UNSUPPORTED_MODE");
		assert.equal(err.mode, ODD);
		assert.deepEqual(err.block, { number: at.n, level: 2, row: 3, col: 5, offset: at.start });
		assert.equal(err.offset, at.mode);
		assert.match(err.message, new RegExp("^block " + at.n + " \\(level 2, row 3, col 5\\): stream 1 uses stream mode 238, which ecw-js does not decode yet\\. .*blastingapps\\.com\\. \\(at 0x" + at.mode.toString(16) + "\\)$"));
		return true;
	});
	// a window clear of that block still reads
	var ok = await r.readRegion({ x: 0, y: 0, width: 16, height: 16 });
	assert.equal(ok.badBlocks, undefined);
});

test("broken stream table: BAD_BLOCK with the block and a file offset", async function () {
	var bytes = build();
	var at = locate(bytes, 1, 0, 0, 0);
	// stream 2 starts before stream 1
	new DataView(bytes.buffer).setUint32(at.start + 4, 0, false);
	new DataView(bytes.buffer).setUint32(at.start, 3, false);
	var r = await openEcw(new Blob([bytes]), { threads: 1 });
	await assert.rejects(r.readRegion(FULL), function (err) {
		assert.equal(err.code, "BAD_BLOCK");
		assert.deepEqual(err.block, { number: at.n, level: 1, row: 0, col: 0, offset: at.start });
		assert.equal(err.offset, at.start + 4);
		assert.match(err.message, /^block \d+ \(level 1, row 0, col 0\): stream 2 starts before stream 1/);
		return true;
	});
});

test("a stream that fails to decode: BAD_BLOCK at its block", async function () {
	var bytes = build();
	var at = locate(bytes, 2, 1, 1, 0);
	var next = locate(bytes, 2, 1, 1, 1);
	// mode 2 with too few bytes for its tree
	bytes[at.mode] = 2;
	bytes[at.mode + 1] = 0xFF;
	bytes[at.mode + 2] = 0xFF;
	assert.ok(next.mode - at.mode > 3);
	var r = await openEcw(new Blob([bytes]), { threads: 1 });
	await assert.rejects(r.readRegion(FULL), function (err) {
		assert.equal(err.code, "BAD_BLOCK");
		assert.deepEqual(err.block, { number: at.n, level: 2, row: 1, col: 1, offset: at.start });
		assert.equal(err.offset, at.start);
		return true;
	});
});

test("skip: reads around bad streams and blocks and lists them", async function () {
	var bytes = build();
	var odd = locate(bytes, 2, 3, 5, 1);
	bytes[odd.mode] = ODD;
	var broken = locate(bytes, 1, 0, 0, 0);
	new DataView(bytes.buffer).setUint32(broken.start, 0xFFFFFF, false);
	var clean = await openEcw(new Blob([build()]), { threads: 1 });
	// no tile cache: its padding would reach the broken block from the small window below
	var r = await openEcw(new Blob([bytes]), { threads: 1, cache: false });
	var res = await r.readRegion(Object.assign({ onBadBlock: "skip" }, FULL));
	assert.equal(res.data.length, 64 * 48 * 4);
	assert.deepEqual(res.badBlocks, [
		{ block: broken.n, level: 1, row: 0, col: 0, offset: broken.start, code: "BAD_BLOCK", message: "stream 1 starts past the block", streams: [] },
		{ block: odd.n, level: 2, row: 3, col: 5, offset: odd.start, code: "UNSUPPORTED_MODE", mode: ODD,
			message: "stream 1 uses stream mode 238, which ecw-js does not decode yet. To help add it, please send an ECW file that uses this mode to blastingapps.com.",
			streams: [{ band: 0, subband: "HL", mode: ODD, code: "UNSUPPORTED_MODE" }] }
	]);
	// pixels far from both blocks are untouched
	var want = (await clean.readRegion(FULL)).data;
	var i = (47 * 64 + 2) * 4;
	assert.deepEqual(Array.from(res.data.subarray(i, i + 4)), Array.from(want.subarray(i, i + 4)));
	// a window that misses both lists nothing
	var none = await r.readRegion({ x: 0, y: 40, width: 8, height: 8, onBadBlock: "skip" });
	assert.deepEqual(none.badBlocks, []);
});

test("skip: a stream that fails to decode reads as zeros and is listed", async function () {
	var bytes = build();
	var at = locate(bytes, 2, 1, 1, 0);
	bytes[at.mode] = 2;
	bytes[at.mode + 1] = 0xFF;
	bytes[at.mode + 2] = 0xFF;
	var r = await openEcw(new Blob([bytes]), { threads: 1 });
	var res = await r.readRegion(Object.assign({ onBadBlock: "skip" }, FULL));
	assert.equal(res.badBlocks.length, 1);
	assert.equal(res.badBlocks[0].code, "BAD_BLOCK");
	assert.equal(res.badBlocks[0].mode, undefined);
	assert.deepEqual(res.badBlocks[0].streams, [{ band: 0, subband: "LH", mode: 2, code: "BAD_BLOCK" }]);
});

test("skip never puts tiles built around bad blocks in the cache", async function () {
	var bytes = build();
	// record 1 feeds the 32 x 24 level read below
	bytes[locate(bytes, 1, 2, 2, 1).mode] = ODD;
	var r = await openEcw(new Blob([bytes]), { threads: 1, cache: { tileSize: 8 } });
	var res = await r.readRegion(Object.assign({ onBadBlock: "skip", outWidth: 32, outHeight: 24 }, FULL));
	assert.equal(res.badBlocks.length, 1);
	await assert.rejects(r.readRegion(Object.assign({ outWidth: 32, outHeight: 24 }, FULL)), { code: "UNSUPPORTED_MODE" });
	// and the same skip read again still lists the block
	assert.equal((await r.readRegion(Object.assign({ onBadBlock: "skip", outWidth: 32, outHeight: 24 }, FULL))).badBlocks.length, 1);
});

test("skip and throw through the worker pool (threads: 2)", async function () {
	var bytes = build();
	var at = locate(bytes, 2, 3, 5, 1);
	bytes[at.mode] = ODD;
	var blob = new Blob([bytes]);
	var one = await openEcw(blob, { threads: 1 });
	var two = await openEcw(blob, { threads: 2 });
	var a = await one.readRegion(Object.assign({ onBadBlock: "skip" }, FULL));
	var b = await two.readRegion(Object.assign({ onBadBlock: "skip" }, FULL));
	assert.ok(two._poolStart, "the pool started");
	assert.deepEqual(Array.from(b.data), Array.from(a.data));
	assert.deepEqual(b.badBlocks, a.badBlocks);
	await assert.rejects(two.readRegion(FULL), function (err) {
		assert.equal(err.code, "UNSUPPORTED_MODE");
		assert.equal(err.mode, ODD);
		assert.deepEqual(err.block, { number: at.n, level: 2, row: 3, col: 5, offset: at.start });
		assert.equal(err.offset, at.mode);
		assert.equal((err.message.match(/\(at 0x/g) || []).length, 1);
		return true;
	});
	await two.close();
	await one.close();
});

test("readRegionToScratch with skip lists the bad blocks once across strips", async function () {
	var bytes = build();
	bytes[locate(bytes, 2, 3, 5, 1).mode] = ODD;
	var r = await openEcw(new Blob([bytes]), { threads: 1 });
	var out = await r.readRegionToScratch(Object.assign({ onBadBlock: "skip", stripBytes: 64 * 4 * 3, scratch: { root: createFakeRoot() } }, FULL));
	assert.equal(out.badBlocks.length, 1);
	assert.equal(out.badBlocks[0].streams.length, 1);
	var plain = await r.readRegionToScratch(Object.assign({ onBadBlock: "skip", scratch: { root: createFakeRoot() } }, { x: 0, y: 0, width: 16, height: 16 }));
	assert.deepEqual(plain.badBlocks, []);
	await r.close();
});

test("onBadBlock must be throw or skip", async function () {
	var r = await openEcw(new Blob([build()]), { threads: 1 });
	await assert.rejects(r.readRegion(Object.assign({ onBadBlock: "blank" }, FULL)), { code: "INVALID_ARGUMENT", message: /onBadBlock/ });
	assert.equal((await r.readRegion(Object.assign({ onBadBlock: "throw" }, FULL))).badBlocks, undefined);
});
