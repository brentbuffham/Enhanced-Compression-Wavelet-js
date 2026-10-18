// _dev/ecw-decode/blockDump.mjs
//==========================================================
// Dumps every stream of one block: level, row/col, the block's
// pixel extent in its level, and each stream's mode and bytes.
// Usage: node _dev/ecw-decode/blockDump.mjs <file> <blockNumber> [maxBytesPerStream]
//==========================================================

import fs from "node:fs";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels } from "../../src/format/EcwLevels.js";
import { parseBlockIndex, blockGrid, blockEntryWindow, blockByteRange } from "../../src/format/EcwBlockIndex.js";
import { splitBlockStreams } from "../../src/format/EcwBlockFrame.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { readFileRange, parseNumberArg, formatHexRows } from "./probeLib.mjs";

var args = process.argv.slice(2);
var file = args[0];
var n = parseNumberArg(args[1]);
var maxBytes = args[2] ? parseNumberArg(args[2]) : 64;
var size = fs.statSync(file).size;
var source = new MemorySource(readFileRange(fs, file, 0, 8192));
var header = parseHeader(source);
var levels = parseLevels(source, header);
var index = parseBlockIndex(source, header);
var grid = blockGrid(header, levels);
var level = grid.findIndex(function (g) { return n < g.firstBlock + g.cols * g.rows; });
var g = grid[level];
var local = n - g.firstBlock;
var row = Math.floor(local / g.cols);
var col = local % g.cols;
var w = blockEntryWindow(index, n);
var r = blockByteRange(index, n, readFileRange(fs, file, w.start, 16), size);
var bytes = readFileRange(fs, file, r.start, r.end - r.start);
var pw = Math.min(header.blockWidth, levels[level].width - col * header.blockWidth);
var ph = Math.min(header.blockHeight, levels[level].height - row * header.blockHeight);
console.log("block " + n + "  level " + level + "  row " + row + " col " + col + "  extent " + pw + "x" + ph + "  bytes " + bytes.length);
splitBlockStreams(bytes, header.bands, level).forEach(function (s, k) {
	console.log("-- stream " + k + "  band " + s.band + " " + s.subband + "  mode " + s.mode + "  payload " + s.bytes.length);
	if (s.bytes.length) formatHexRows(s.bytes.subarray(0, maxBytes), 0, []).forEach(function (line) { console.log("   " + line); });
});
