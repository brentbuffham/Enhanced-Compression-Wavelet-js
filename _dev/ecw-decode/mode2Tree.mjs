// _dev/ecw-decode/mode2Tree.mjs
//==========================================================
// Hypothesis search for mode-2 streams: u32 LE N, then an N-byte
// bit-packed pre-order Huffman tree, then the coded bitstream.
// Tries bit order x leaf-flag polarity x symbol width and reports,
// per variant, how many streams yield a tree that completes
// within N bytes leaving < 8 padding bits.
// Usage: node _dev/ecw-decode/mode2Tree.mjs <file> [samples]
//==========================================================

import fs from "node:fs";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels } from "../../src/format/EcwLevels.js";
import { parseBlockIndex, blockGrid, blockEntryWindow, blockByteRange, totalBlocks } from "../../src/format/EcwBlockIndex.js";
import { splitBlockStreams } from "../../src/format/EcwBlockFrame.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { readFileRange } from "./probeLib.mjs";

export function bitReader(bytes, lsbFirst) {
	var pos = 0;
	return {
		bit: function () {
			if (pos >= bytes.length * 8) throw new Error("eof");
			var b = bytes[pos >> 3];
			var v = lsbFirst ? (b >> (pos & 7)) & 1 : (b >> (7 - (pos & 7))) & 1;
			pos++;
			return v;
		},
		bits: function (n, lsbValue) {
			var v = 0;
			for (var i = 0; i < n; i++) {
				var b = this.bit();
				v = lsbValue ? v | (b << i) : (v << 1) | b;
			}
			return v;
		},
		pos: function () { return pos; }
	};
}

export function parseTree(reader, leafFlag, symBits, lsbValue, depth) {
	if (depth > 40) throw new Error("deep");
	if (reader.bit() === leafFlag) return { sym: reader.bits(symBits, lsbValue) };
	var left = parseTree(reader, leafFlag, symBits, lsbValue, depth + 1);
	var right = parseTree(reader, leafFlag, symBits, lsbValue, depth + 1);
	return { left: left, right: right };
}

function leaves(t, out) {
	if (t.sym !== undefined) out.push(t.sym);
	else { leaves(t.left, out); leaves(t.right, out); }
	return out;
}

var isMain = process.argv[1] && process.argv[1].endsWith("mode2Tree.mjs");
if (isMain) {
	var file = process.argv[2];
	var samples = Number(process.argv[3] || 3000);
	var size = fs.statSync(file).size;
	var source = new MemorySource(readFileRange(fs, file, 0, 8192));
	var header = parseHeader(source);
	var levels = parseLevels(source, header);
	var index = parseBlockIndex(source, header);
	var grid = blockGrid(header, levels);
	var total = totalBlocks(grid);
	var streams = [];
	for (var i = 0; i < samples && streams.length < 400; i++) {
		var n = Math.floor(i * total / samples);
		var level = grid.findIndex(function (g) { return n < g.firstBlock + g.cols * g.rows; });
		var w = blockEntryWindow(index, n);
		var r = blockByteRange(index, n, readFileRange(fs, file, w.start, 16), size);
		splitBlockStreams(readFileRange(fs, file, r.start, r.end - r.start), header.bands, level).forEach(function (s) {
			if (s.mode === 2) streams.push(s.bytes);
		});
	}
	var results = [];
	[false, true].forEach(function (lsbFirst) {
		[0, 1].forEach(function (leafFlag) {
			[8, 16].forEach(function (symBits) {
				[false, true].forEach(function (lsbValue) {
					var ok = 0, example = null;
					streams.forEach(function (bytes) {
						var N = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
						var table = bytes.subarray(4, 4 + N);
						try {
							var rd = bitReader(table, lsbFirst);
							var t = parseTree(rd, leafFlag, symBits, lsbValue, 0);
							if (N * 8 - rd.pos() < 8) { ok++; if (!example) example = leaves(t, []).map(function (v) { return v.toString(16); }); }
						} catch (err) { /* incomplete */ }
					});
					results.push({ lsbFirst: lsbFirst, leafFlag: leafFlag, symBits: symBits, lsbValue: lsbValue, ok: ok, of: streams.length, example: example && example.slice(0, 12).join(",") });
				});
			});
		});
	});
	results.sort(function (a, b) { return b.ok - a.ok; });
	results.slice(0, 6).forEach(function (r) { console.log(JSON.stringify(r)); });
}
