// test/decode/RegionDecoder.test.js
//==========================================================
// Windowed multi-level reconstruction over synthetic coded files.
// Run with: node --test test/decode/RegionDecoder.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeWindow, imageLevelSize, createDecodeContext, countWindowBlocks } from "../../src/decode/RegionDecoder.js";
import { synthesizeWindow } from "../../src/codec/wavelet.js";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels } from "../../src/format/EcwLevels.js";
import { parseBlockIndex, blockGrid, blockEntryWindow, blockByteRange } from "../../src/format/EcwBlockIndex.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { buildCodedFile } from "../helpers/buildCodedFile.js";

function contextFor(bytes, opts) {
	var source = new MemorySource(bytes);
	var header = parseHeader(source);
	var levels = parseLevels(source, header);
	var index = parseBlockIndex(source, header);
	var fetches = 0;
	var ctx = createDecodeContext({
		header: header, levels: levels, index: index, grid: blockGrid(header, levels),
		signal: opts && opts.signal,
		fetchBlock: async function (n) {
			fetches++;
			var w = blockEntryWindow(index, n);
			var r = blockByteRange(index, n, bytes.subarray(w.start, w.end), bytes.length);
			return bytes.subarray(r.start, r.end);
		}
	});
	return { ctx: ctx, header: header, levels: levels, fetches: function () { return fetches; } };
}

function hash(r, b, sb, x, y) {
	var v = (r * 7919 + b * 104729 + sb.charCodeAt(0) * 31 + sb.charCodeAt(1) * 17 + x * 131 + y * 977) % 23;
	return sb === "LL" ? 40 + v : v - 11;
}

// Reference: full planes straight from the coefficient function, synthesised level by level
function naive(o, levels, band) {
	var img = null, w = 0, h = 0;
	levels.forEach(function (lv, r) {
		var p = { w: lv.width, h: lv.height, x0: 0, y0: 0, width: lv.width, height: lv.height };
		["LL", "LH", "HL", "HH"].forEach(function (sb) {
			p[sb] = new Float32Array(lv.width * lv.height);
			for (var y = 0; y < lv.height; y++) for (var x = 0; x < lv.width; x++) {
				p[sb][y * lv.width + x] = sb === "LL" ? (r === 0 ? o.coeff(0, band, "LL", x, y) : img[y * (2 * w) + x]) : o.coeff(r, band, sb, x, y);
			}
		});
		img = synthesizeWindow(p, 0, 0, 2 * lv.width, 2 * lv.height);
		w = lv.width; h = lv.height;
	});
	return { data: img, stride: 2 * w };
}

test("imageLevelSize: records then full resolution", function () {
	var f = contextFor(buildCodedFile({ width: 30, height: 20, levelCount: 2, coeff: function () { return 0; } }).bytes);
	assert.deepEqual(imageLevelSize(f.header, f.levels, 0), { width: 8, height: 5 });
	assert.deepEqual(imageLevelSize(f.header, f.levels, 1), { width: 15, height: 10 });
	assert.deepEqual(imageLevelSize(f.header, f.levels, 2), { width: 30, height: 20 });
});

test("constant LL with zero details reconstructs a constant image", async function () {
	var o = { width: 30, height: 20, levelCount: 2, coeff: function (r, b, sb) { return r === 0 && b === 0 && sb === "LL" ? 77 : 0; } };
	var f = contextFor(buildCodedFile(o).bytes);
	var win = await decodeWindow(f.ctx, 2, 0, 0, 30, 20);
	assert.equal(win.width, 30);
	assert.equal(win.height, 20);
	assert.ok(win.bands[0].every(function (v) { return v === 77; }));
	assert.ok(win.bands[1].every(function (v) { return v === 0; }));
});

test("full decode matches the plane-by-plane reference", async function () {
	var o = { width: 30, height: 21, levelCount: 3, coeff: hash };
	var built = buildCodedFile(o);
	var f = contextFor(built.bytes);
	var win = await decodeWindow(f.ctx, 3, 0, 0, 30, 21);
	for (var b = 0; b < 3; b++) {
		var ref = naive(o, built.levels, b);
		for (var y = 0; y < 21; y++) for (var x = 0; x < 30; x++) assert.equal(win.bands[b][y * 30 + x], ref.data[y * ref.stride + x], "band " + b + " at " + x + "," + y);
	}
});

test("a window equals the matching crop of the full decode, with fewer block reads", async function () {
	var o = { width: 64, height: 48, levelCount: 3, coeff: hash };
	var bytes = buildCodedFile(o).bytes;
	var full = contextFor(bytes);
	var whole = await decodeWindow(full.ctx, 3, 0, 0, 64, 48);
	var part = contextFor(bytes);
	var win = await decodeWindow(part.ctx, 3, 37, 9, 50, 20);
	for (var b = 0; b < 3; b++) for (var y = 9; y < 20; y++) for (var x = 37; x < 50; x++) assert.equal(win.bands[b][(y - 9) * 13 + x - 37], whole.bands[b][y * 64 + x]);
	assert.ok(part.fetches() < full.fetches(), part.fetches() + " < " + full.fetches());
});

test("coarser image levels decode directly", async function () {
	var o = { width: 30, height: 21, levelCount: 3, coeff: hash };
	var built = buildCodedFile(o);
	var f = contextFor(built.bytes);
	var lvl0 = await decodeWindow(f.ctx, 0, 0, 0, 4, 3);
	assert.equal(lvl0.bands[0][0], hash(0, 0, "LL", 0, 0));
	assert.equal(lvl0.bands[2][2 * 4 + 3], hash(0, 2, "LL", 3, 2));
});

test("each block is fetched once per context", async function () {
	var f = contextFor(buildCodedFile({ width: 30, height: 21, levelCount: 3, coeff: hash }).bytes);
	await decodeWindow(f.ctx, 3, 0, 0, 30, 21);
	var first = f.fetches();
	await decodeWindow(f.ctx, 3, 5, 5, 10, 10);
	assert.equal(f.fetches(), first);
});

test("an aborted signal rejects with ABORTED", async function () {
	var controller = new AbortController();
	controller.abort();
	var f = contextFor(buildCodedFile({ width: 30, height: 21, levelCount: 3, coeff: hash }).bytes, { signal: controller.signal });
	await assert.rejects(decodeWindow(f.ctx, 3, 0, 0, 30, 21), { code: "ABORTED" });
});

test("a window outside the level throws INVALID_ARGUMENT", async function () {
	var f = contextFor(buildCodedFile({ width: 30, height: 21, levelCount: 3, coeff: hash }).bytes);
	await assert.rejects(decodeWindow(f.ctx, 3, 0, 0, 31, 21), { code: "INVALID_ARGUMENT" });
	await assert.rejects(decodeWindow(f.ctx, 3, 5, 5, 5, 9), { code: "INVALID_ARGUMENT" });
	await assert.rejects(decodeWindow(f.ctx, 4, 0, 0, 1, 1), { code: "INVALID_ARGUMENT" });
});

test("countWindowBlocks predicts exactly the blocks a decode fetches", async function () {
	var bytes = buildCodedFile({ width: 64, height: 48, levelCount: 3, coeff: hash }).bytes;
	for (var w of [[0, 0, 64, 48], [37, 9, 50, 20], [0, 0, 1, 1]]) {
		var f = contextFor(bytes);
		var predicted = countWindowBlocks(f.ctx, 3, w[0], w[1], w[2], w[3]);
		await decodeWindow(f.ctx, 3, w[0], w[1], w[2], w[3]);
		assert.equal(predicted, f.fetches(), JSON.stringify(w));
	}
});

test("detail coefficients are scaled by the record's a / b / c steps per band", async function () {
	var coeff = function (r, b, sb, x, y) { return r === 0 && sb === "LL" ? 50 : (r === 1 && sb === "HL" && x === 2 && y === 1 ? 3 : 0); };
	var steps = function (r) { return r === 1 ? { a: 4, b: 2, c: 8 } : { a: 1, b: 1, c: 1 }; };
	var plain = buildCodedFile({ width: 32, height: 24, levelCount: 2, coeff: coeff });
	var scaled = buildCodedFile({ width: 32, height: 24, levelCount: 2, coeff: coeff, steps: steps });
	var ref = await decodeWindow(contextFor(plain.bytes).ctx, 2, 0, 0, 32, 24);
	var got = await decodeWindow(contextFor(scaled.bytes).ctx, 2, 0, 0, 32, 24);
	var bandStep = [4, 2, 8];
	for (var b = 0; b < 3; b++) for (var i = 0; i < 32 * 24; i++) {
		// LL is not scaled; only the detail contribution grows by the band's step
		var expected = 50 + (ref.bands[b][i] - 50) * bandStep[b];
		assert.equal(got.bands[b][i], expected, "band " + b + " pixel " + i);
	}
});

test("a band whose detail streams are all empty in a block takes the exact path", async function () {
	// band 0 has details in every block of every record (general path, quarter-floored);
	// bands 1 and 2 have none anywhere (exact path everywhere)
	var o = { width: 64, height: 48, levelCount: 3, coeff: function (r, b, sb, x, y) {
		if (r === 0 && sb === "LL") return 20 + ((x * 37 + y * 101 + b * 7) % 150);
		return b === 0 ? ((x + y + sb.length + r) % 3) - 1 || 1 : 0;
	} };
	var built = buildCodedFile(o);
	var got = await decodeWindow(contextFor(built.bytes).ctx, 3, 0, 0, 64, 48);
	function reference(band, floorIt) {
		var img = null, w = 0;
		built.levels.forEach(function (lv, r) {
			var p = { w: lv.width, h: lv.height, x0: 0, y0: 0, width: lv.width, height: lv.height, floorAt: function () { return floorIt; } };
			["LL", "LH", "HL", "HH"].forEach(function (sb) {
				p[sb] = new Float32Array(lv.width * lv.height);
				for (var y = 0; y < lv.height; y++) for (var x = 0; x < lv.width; x++) p[sb][y * lv.width + x] = sb === "LL" ? (r === 0 ? o.coeff(0, band, "LL", x, y) : img[y * (2 * w) + x]) : o.coeff(r, band, sb, x, y);
			});
			img = synthesizeWindow(p, 0, 0, 2 * lv.width, 2 * lv.height);
			w = lv.width;
		});
		return { data: img, stride: 2 * w };
	}
	var expected = [reference(0, true), reference(1, false), reference(2, false)];
	for (var b = 0; b < 3; b++) for (var y = 0; y < 48; y++) for (var x = 0; x < 64; x++) {
		assert.equal(got.bands[b][y * 64 + x], expected[b].data[y * expected[b].stride + x], "band " + b + " at " + x + "," + y);
	}
});
