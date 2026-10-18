// _dev/ecw-decode/mode2Bytes.mjs
//==========================================================
// Hypothesis test: mode-2 table is a byte-token pre-order tree.
//   0x00 = internal node, 0x80 = leaf + u16 LE word, other = 1-byte leaf
// Reports how often the parse ends exactly at 4 + N.
// Usage: node _dev/ecw-decode/mode2Bytes.mjs <file> [samples]
//==========================================================

import fs from "node:fs";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels } from "../../src/format/EcwLevels.js";
import { parseBlockIndex, blockGrid, blockEntryWindow, blockByteRange, totalBlocks } from "../../src/format/EcwBlockIndex.js";
import { splitBlockStreams } from "../../src/format/EcwBlockFrame.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { readFileRange } from "./probeLib.mjs";

export function collectStreams(file, samples, mode, limit) {
	var size = fs.statSync(file).size;
	var source = new MemorySource(readFileRange(fs, file, 0, 8192));
	var header = parseHeader(source);
	var levels = parseLevels(source, header);
	var index = parseBlockIndex(source, header);
	var grid = blockGrid(header, levels);
	var total = totalBlocks(grid);
	var out = [];
	for (var i = 0; i < samples && out.length < limit; i++) {
		var n = Math.floor(i * total / samples);
		var level = grid.findIndex(function (g) { return n < g.firstBlock + g.cols * g.rows; });
		var g = grid[level];
		var local = n - g.firstBlock;
		var row = Math.floor(local / g.cols), col = local % g.cols;
		var pw = Math.min(header.blockWidth, levels[level].width - col * header.blockWidth);
		var ph = Math.min(header.blockHeight, levels[level].height - row * header.blockHeight);
		var w = blockEntryWindow(index, n);
		var r = blockByteRange(index, n, readFileRange(fs, file, w.start, 16), size);
		splitBlockStreams(readFileRange(fs, file, r.start, r.end - r.start), header.bands, level).forEach(function (s, k) {
			if (s.mode === mode && out.length < limit) out.push({ n: n, level: level, stream: k, band: s.band, subband: s.subband, count: pw * ph, bytes: s.bytes });
		});
	}
	return out;
}

function parse(b, p) {
	var leaves = 0;
	function node() {
		if (p >= b.length) throw new Error("eof");
		var t = b[p++];
		if (t === 0) { node(); node(); return; }
		if (t === 0x80) p += 2;
		leaves++;
	}
	node();
	return { end: p, leaves: leaves };
}

if (process.argv[1] && process.argv[1].endsWith("mode2Bytes.mjs")) {
	var streams = collectStreams(process.argv[2], Number(process.argv[3] || 6000), 2, 400);
	var exact = 0;
	var examples = [];
	streams.forEach(function (s) {
		var b = s.bytes;
		var N = b[0] | (b[1] << 8) | (b[2] << 16);
		try {
			var res = parse(b, 4);
			if (res.end - 4 === N) exact++;
			else if (examples.length < 8) examples.push({ N: N, end: res.end - 4, leaves: res.leaves, len: b.length });
		} catch (err) {
			if (examples.length < 8) examples.push({ N: N, err: err.message, len: b.length });
		}
	});
	console.log(JSON.stringify({ streams: streams.length, exact: exact }));
	examples.forEach(function (e) { console.log(JSON.stringify(e)); });
}
