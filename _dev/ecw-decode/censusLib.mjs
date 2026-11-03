// _dev/ecw-decode/censusLib.mjs
//==========================================================
// Pure core of the stream mode census (modeCensus.mjs). Reads each
// block's stream table and the first byte of every stream, counts
// modes per level record and per stream slot, and lists every stream
// whose mode the library does not decode, with its file address.
// Never throws on bad framing: problems are collected as errors so a
// whole file can be surveyed in one pass.
//==========================================================

import { streamCount, STREAM_MODE } from "../../src/format/EcwBlockFrame.js";

var LEVEL0_SUBBANDS = ["LL", "LH", "HL", "HH"];
var DETAIL_SUBBANDS = ["LH", "HL", "HH"];

/** Modes the library decodes today (from STREAM_MODE, so it follows the code). */
export var SUPPORTED_MODES = Object.values(STREAM_MODE).slice().sort(function (a, b) { return a - b; });

/**
 * New census for one file.
 * @param {{bands:number, blockWidth:number, blockHeight:number}} header
 * @param {Array<{width:number, height:number}>} levels - parseLevels() result.
 * @param {Array<{cols:number, rows:number, firstBlock:number}>} grid - blockGrid() result.
 */
export function createCensus(header, levels, grid) {
	var supported = new Uint8Array(256);
	SUPPORTED_MODES.forEach(function (m) { supported[m] = 1; });
	var maxStreams = 0;
	var lvls = levels.map(function (lv, i) {
		var streams = streamCount(header.bands, i);
		if (streams > maxStreams) maxStreams = streams;
		return {
			record: i, width: lv.width, height: lv.height,
			cols: grid[i].cols, rows: grid[i].rows, firstBlock: grid[i].firstBlock,
			streams: streams, subbands: i === 0 ? LEVEL0_SUBBANDS : DETAIL_SUBBANDS,
			blocks: 0, bytes: 0,
			modes: new Float64Array(256),
			// modes in blocks cut short by the level's right or bottom edge
			edgeModes: new Float64Array(256),
			// count per stream slot: [slot * 256 + mode]
			bySlot: new Float64Array(streams * 256)
		};
	});
	return {
		bands: header.bands, blockWidth: header.blockWidth, blockHeight: header.blockHeight,
		supported: supported, levels: lvls, unsupported: [], errors: [],
		_starts: new Float64Array(maxStreams + 1)
	};
}

function u32be(buf, p) {
	return ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
}

/**
 * Count one block. buf[start, end) holds the whole block, which sits at
 * fileOffset in the file.
 * @returns {boolean} false if the block's stream table is bad (recorded in errors)
 */
export function censusBlock(c, record, row, col, n, buf, start, end, fileOffset) {
	var lv = c.levels[record];
	var count = lv.streams;
	var headerLength = (count - 1) * 4;
	var length = end - start;
	var where = { block: n, record: record, row: row, col: col, blockOffset: fileOffset };
	lv.blocks++;
	lv.bytes += length;
	function fail(message, at) {
		where.message = message;
		where.at = fileOffset + at;
		c.errors.push(where);
		return false;
	}
	if (length < headerLength) return fail("block shorter than its stream table", 0);
	var bodyLength = length - headerLength;
	var starts = c._starts;
	starts[0] = 0;
	for (var k = 1; k < count; k++) {
		var rel = u32be(buf, start + (k - 1) * 4);
		if (rel < starts[k - 1]) return fail("stream " + k + " starts before stream " + (k - 1), (k - 1) * 4);
		if (rel > bodyLength) return fail("stream " + k + " starts past the block", (k - 1) * 4);
		starts[k] = rel;
	}
	starts[count] = bodyLength;
	var pw = Math.min(c.blockWidth, lv.width - col * c.blockWidth);
	var ph = Math.min(c.blockHeight, lv.height - row * c.blockHeight);
	var edge = pw < c.blockWidth || ph < c.blockHeight;
	var per = lv.subbands.length;
	for (k = 0; k < count; k++) {
		var s = headerLength + starts[k], e = headerLength + starts[k + 1];
		if (e <= s) return fail("stream " + k + " is empty", s);
		var mode = buf[start + s];
		lv.modes[mode]++;
		lv.bySlot[k * 256 + mode]++;
		if (edge) lv.edgeModes[mode]++;
		if (mode === STREAM_MODE.EMPTY && e - s !== 1) fail("empty stream " + k + " is longer than one byte", s);
		if (!c.supported[mode]) {
			c.unsupported.push({
				block: n, record: record, row: row, col: col, pw: pw, ph: ph,
				stream: k, band: Math.floor(k / per), subband: lv.subbands[k % per],
				mode: mode, blockOffset: fileOffset, modeOffset: fileOffset + s, length: e - s
			});
		}
	}
	return true;
}

/**
 * Totals across levels.
 * @returns {{blocks:number, bytes:number, streams:number, modes:Object<number,{streams:number, edge:number, levels:number[]}>}}
 */
export function censusTotals(c) {
	var out = { blocks: 0, bytes: 0, streams: 0, modes: {} };
	c.levels.forEach(function (lv) {
		out.blocks += lv.blocks;
		out.bytes += lv.bytes;
		for (var m = 0; m < 256; m++) {
			if (!lv.modes[m]) continue;
			var t = out.modes[m] || (out.modes[m] = { streams: 0, edge: 0, levels: [] });
			t.streams += lv.modes[m];
			t.edge += lv.edgeModes[m];
			t.levels.push(lv.record);
			out.streams += lv.modes[m];
		}
	});
	return out;
}

/**
 * Unsupported streams grouped by mode, level record and block row, so a
 * run of blocks along one edge reads as one line.
 * @returns {Array<{mode:number, record:number, row:number, blocks:number, streams:number,
 *   colMin:number, colMax:number, slots:string[], shapes:string[], lengthMin:number, lengthMax:number}>}
 */
export function groupUnsupported(c) {
	var groups = new Map();
	c.unsupported.forEach(function (u) {
		var key = u.mode + "/" + u.record + "/" + u.row;
		var g = groups.get(key);
		if (!g) {
			g = { mode: u.mode, record: u.record, row: u.row, blocks: 0, streams: 0, colMin: u.col, colMax: u.col,
				slots: [], shapes: [], lengthMin: u.length, lengthMax: u.length, _blocks: new Set() };
			groups.set(key, g);
		}
		g.streams++;
		if (!g._blocks.has(u.block)) { g._blocks.add(u.block); g.blocks++; }
		g.colMin = Math.min(g.colMin, u.col);
		g.colMax = Math.max(g.colMax, u.col);
		g.lengthMin = Math.min(g.lengthMin, u.length);
		g.lengthMax = Math.max(g.lengthMax, u.length);
		var slot = "b" + u.band + " " + u.subband, shape = u.pw + "x" + u.ph;
		if (g.slots.indexOf(slot) < 0) g.slots.push(slot);
		if (g.shapes.indexOf(shape) < 0) g.shapes.push(shape);
	});
	return Array.from(groups.values()).map(function (g) { delete g._blocks; return g; })
		.sort(function (a, b) { return a.mode - b.mode || a.record - b.record || a.row - b.row; });
}
