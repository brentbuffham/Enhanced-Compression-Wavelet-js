// _dev/ecw-decode/levelPlanes.mjs
//==========================================================
// Decodes every block of one level into coefficient planes:
// planes[band][subband] = Int32Array(levelW * levelH), raster order,
// assuming each stream lists its block's values row by row.
// Uses the cracked mode 2 / 5 / 6 stream codings (FINDINGS.md).
//==========================================================

import fs from "node:fs";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels } from "../../src/format/EcwLevels.js";
import { parseBlockIndex, blockGrid, blockEntryWindow, blockByteRange } from "../../src/format/EcwBlockIndex.js";
import { splitBlockStreams } from "../../src/format/EcwBlockFrame.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { readFileRange } from "./probeLib.mjs";
import { decodeMode6 } from "./mode6Check.mjs";
import { readTree } from "./mode2Decode.mjs";

export function decodeMode2Values(bytes, count) {
	var t = readTree(bytes, { 4: "+", 5: "-", 6: "z" });
	var pos = t.dataStart * 8;
	var out = new Int32Array(count);
	var n = 0;
	while (n < count) {
		var node = t.root;
		while (!node.leaf) {
			node = ((bytes[pos >> 3] >> (pos & 7)) & 1) === 0 ? node.left : node.right;
			pos++;
		}
		if (node.leaf.run) n += node.leaf.run;
		else out[n++] = node.leaf.value;
	}
	return out;
}

export function decodeStream(s, count) {
	if (s.mode === 5) return new Int32Array(count);
	if (s.mode === 6) return Int32Array.from(decodeMode6(s.bytes).values);
	return decodeMode2Values(s.bytes, count);
}

export function openFile(file) {
	var size = fs.statSync(file).size;
	var source = new MemorySource(readFileRange(fs, file, 0, 8192));
	var header = parseHeader(source);
	var levels = parseLevels(source, header);
	return { file: file, size: size, header: header, levels: levels, index: parseBlockIndex(source, header), grid: blockGrid(header, levels) };
}

export function levelPlanes(f, level) {
	var h = f.header;
	var lv = f.levels[level];
	var g = f.grid[level];
	var subbands = level === 0 ? ["LL", "LH", "HL", "HH"] : ["LH", "HL", "HH"];
	var planes = [];
	for (var b = 0; b < h.bands; b++) {
		planes.push({});
		subbands.forEach(function (sb) { planes[b][sb] = new Int32Array(lv.width * lv.height); });
	}
	for (var row = 0; row < g.rows; row++) {
		for (var col = 0; col < g.cols; col++) {
			var n = g.firstBlock + row * g.cols + col;
			var pw = Math.min(h.blockWidth, lv.width - col * h.blockWidth);
			var ph = Math.min(h.blockHeight, lv.height - row * h.blockHeight);
			var w = blockEntryWindow(f.index, n);
			var r = blockByteRange(f.index, n, readFileRange(fs, f.file, w.start, 16), f.size);
			splitBlockStreams(readFileRange(fs, f.file, r.start, r.end - r.start), h.bands, level).forEach(function (s) {
				var vals = decodeStream(s, pw * ph);
				var plane = planes[s.band][s.subband];
				for (var y = 0; y < ph; y++) {
					for (var x = 0; x < pw; x++) {
						plane[(row * h.blockHeight + y) * lv.width + col * h.blockWidth + x] = vals[y * pw + x];
					}
				}
			});
		}
	}
	return { width: lv.width, height: lv.height, planes: planes };
}
