// _dev/ecw-decode/mode6Check.mjs
//==========================================================
// Hypothesis test for mode-6 streams: u16 LE words, top 2 bits
// 00 = +value, 01 = -value, 10 = zero run, 11 = unknown.
// For sampled blocks, decodes every mode-6 stream and checks the
// value count equals the block's extent (w x h in its level) and
// that the stream is consumed exactly.
// Usage: node _dev/ecw-decode/mode6Check.mjs <file> [samples]
//==========================================================

import fs from "node:fs";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels } from "../../src/format/EcwLevels.js";
import { parseBlockIndex, blockGrid, blockEntryWindow, blockByteRange, } from "../../src/format/EcwBlockIndex.js";
import { totalBlocks } from "../../src/format/EcwBlockIndex.js";
import { splitBlockStreams } from "../../src/format/EcwBlockFrame.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { readFileRange } from "./probeLib.mjs";

export function decodeMode6(bytes) {
	var values = [];
	var tag11 = 0;
	if (bytes.length % 2) return { values: values, odd: true };
	for (var i = 0; i < bytes.length; i += 2) {
		var w = bytes[i] | (bytes[i + 1] << 8);
		var tag = w >> 14;
		var v = w & 0x3FFF;
		if (tag === 0) values.push(v);
		else if (tag === 1) values.push(-v);
		else if (tag === 2) for (var k = 0; k < v; k++) values.push(0);
		else tag11++;
	}
	return { values: values, tag11: tag11 };
}

var file = process.argv[2];
var samples = Number(process.argv[3] || 4000);
var size = fs.statSync(file).size;
var source = new MemorySource(readFileRange(fs, file, 0, 8192));
var header = parseHeader(source);
var levels = parseLevels(source, header);
var index = parseBlockIndex(source, header);
var grid = blockGrid(header, levels);
var total = totalBlocks(grid);
var stats = { streams: 0, match: 0, mismatch: 0, odd: 0, tag11: 0 };
var examples = [];
for (var i = 0; i < samples; i++) {
	var n = Math.floor(i * total / samples);
	var level = grid.findIndex(function (g) { return n < g.firstBlock + g.cols * g.rows; });
	var g = grid[level];
	var local = n - g.firstBlock;
	var row = Math.floor(local / g.cols), col = local % g.cols;
	var pw = Math.min(header.blockWidth, levels[level].width - col * header.blockWidth);
	var ph = Math.min(header.blockHeight, levels[level].height - row * header.blockHeight);
	var w = blockEntryWindow(index, n);
	var r = blockByteRange(index, n, readFileRange(fs, file, w.start, 16), size);
	var streams = splitBlockStreams(readFileRange(fs, file, r.start, r.end - r.start), header.bands, level);
	streams.forEach(function (s, k) {
		if (s.mode !== 6) return;
		stats.streams++;
		var d = decodeMode6(s.bytes);
		if (d.odd) { stats.odd++; return; }
		if (d.tag11) stats.tag11++;
		if (d.values.length === pw * ph) stats.match++;
		else {
			stats.mismatch++;
			if (examples.length < 8) examples.push({ n: n, level: level, stream: k, extent: pw + "x" + ph, got: d.values.length });
		}
	});
}
console.log(JSON.stringify(stats));
examples.forEach(function (e) { console.log(JSON.stringify(e)); });
