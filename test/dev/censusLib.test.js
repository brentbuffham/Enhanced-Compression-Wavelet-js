// test/dev/censusLib.test.js
//==========================================================
// Stream mode census core, on synthetic blocks.
// Run with: node --test test/dev/censusLib.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCensus, censusBlock, censusTotals, groupUnsupported, SUPPORTED_MODES } from "../../_dev/ecw-decode/censusLib.mjs";

// An arbitrary byte the library does not decode
var ODD = 0xEE;

// streams: [[mode, ...payload], ...]
function buildBlock(streams) {
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

function streams(n, fill) { return Array.from({ length: n }, function (_, i) { return fill ? fill(i) : [5]; }); }

// 1 band, 2 records: 100x70 (2x2 blocks of 64) and 200x140 (4x3)
function census() {
	var header = { bands: 1, blockWidth: 64, blockHeight: 64 };
	var levels = [{ width: 100, height: 70 }, { width: 200, height: 140 }];
	var grid = [{ cols: 2, rows: 2, firstBlock: 0 }, { cols: 4, rows: 3, firstBlock: 4 }];
	return createCensus(header, levels, grid);
}

test("supported modes follow STREAM_MODE", function () {
	assert.deepEqual(SUPPORTED_MODES, [2, 3, 5, 6]);
});

test("counts modes per level, per slot and in edge blocks", function () {
	var c = census();
	// level 0: 4 streams (LL LH HL HH); a full block then an edge block
	var a = buildBlock([[2, 1], [6, 1, 2], [5], [5]]);
	assert.equal(censusBlock(c, 0, 0, 0, 0, a, 0, a.length, 0), true);
	var b = buildBlock([[2, 9], [5], [5], [5]]);
	assert.equal(censusBlock(c, 0, 0, 1, 1, b, 0, b.length, 100), true);
	var lv = c.levels[0];
	assert.equal(lv.blocks, 2);
	assert.equal(lv.modes[2], 2);
	assert.equal(lv.modes[5], 5);
	assert.equal(lv.modes[6], 1);
	assert.equal(lv.edgeModes[2], 1);
	assert.equal(lv.edgeModes[5], 3);
	assert.equal(lv.bySlot[0 * 256 + 2], 2);
	assert.equal(lv.bySlot[1 * 256 + 6], 1);
	assert.equal(c.unsupported.length, 0);
	assert.equal(c.errors.length, 0);
});

test("lists an unsupported stream with its file address and block shape", function () {
	var c = census();
	// level 1 has 3 streams; put the block at file offset 1000 inside a padded buffer
	var block = buildBlock([[5], [ODD, 0, 7, 7], [2, 4]]);
	var buf = new Uint8Array(block.length + 20);
	buf.set(block, 10);
	censusBlock(c, 1, 2, 3, 15, buf, 10, 10 + block.length, 1000);
	assert.equal(c.unsupported.length, 1);
	assert.deepEqual(c.unsupported[0], {
		block: 15, record: 1, row: 2, col: 3, pw: 8, ph: 12,
		stream: 1, band: 0, subband: "HL", mode: ODD,
		blockOffset: 1000, modeOffset: 1000 + 8 + 1, length: 4
	});
	assert.equal(c.levels[1].edgeModes[ODD], 1);
});

test("bad stream tables are recorded, not thrown", function () {
	var c = census();
	var falling = buildBlock(streams(4));
	new DataView(falling.buffer).setUint32(4, 0, false);
	new DataView(falling.buffer).setUint32(0, 2, false);
	censusBlock(c, 0, 0, 0, 0, falling, 0, falling.length, 50);
	censusBlock(c, 0, 0, 0, 0, new Uint8Array(5), 0, 5, 60);
	var past = buildBlock(streams(4));
	new DataView(past.buffer).setUint32(8, 99, false);
	censusBlock(c, 0, 0, 0, 0, past, 0, past.length, 70);
	var empty = buildBlock([[5], [], [5], [5]]);
	censusBlock(c, 0, 0, 0, 0, empty, 0, empty.length, 80);
	var long = buildBlock([[5, 0], [5], [5], [5]]);
	assert.equal(censusBlock(c, 0, 0, 0, 0, long, 0, long.length, 90), true);
	assert.deepEqual(c.errors.map(function (e) { return e.message; }), [
		"stream 2 starts before stream 1",
		"block shorter than its stream table",
		"stream 3 starts past the block",
		"stream 1 is empty",
		"empty stream 0 is longer than one byte"
	]);
	assert.equal(c.errors[0].at, 54);
	assert.equal(c.errors[0].blockOffset, 50);
	assert.equal(c.errors[3].at, 80 + 13);
});

test("totals and grouped unsupported streams", function () {
	var c = census();
	for (var col = 0; col < 4; col++) {
		var b = buildBlock([[ODD, 1], col < 2 ? [ODD, 1, 2] : [5], [5]]);
		censusBlock(c, 1, 2, col, 12 + col, b, 0, b.length, col * 100);
	}
	var t = censusTotals(c);
	assert.equal(t.blocks, 4);
	assert.equal(t.streams, 12);
	assert.deepEqual(t.modes[ODD], { streams: 6, edge: 6, levels: [1] });
	assert.deepEqual(groupUnsupported(c), [{
		mode: ODD, record: 1, row: 2, blocks: 4, streams: 6, colMin: 0, colMax: 3,
		slots: ["b0 LH", "b0 HL"], shapes: ["64x12", "8x12"], lengthMin: 2, lengthMax: 3
	}]);
});
