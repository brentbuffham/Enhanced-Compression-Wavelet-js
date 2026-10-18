// _dev/ecw-decode/blockTable.mjs
//==========================================================
// Walks a run of u64 LE values from <start> while they keep
// rising, and reports count, range, deltas and how the run ends
// relative to the file size. Used to pin the block offset table.
// Usage: node _dev/ecw-decode/blockTable.mjs <file> <start> [maxEntries]
//==========================================================

import fs from "node:fs";
import { parseNumberArg } from "./probeLib.mjs";

var args = process.argv.slice(2);
if (args.length < 2) {
	console.error("usage: blockTable.mjs <file> <start> [maxEntries]");
	process.exit(2);
}
var file = args[0];
var start = parseNumberArg(args[1]);
var maxEntries = args[2] ? parseNumberArg(args[2]) : 50000000;
var fd = fs.openSync(file, "r");
var size = fs.fstatSync(fd).size;
var CHUNK = 1 << 20;
var buf = Buffer.alloc(CHUNK);
var values = [];
var pos = start;
var prev = -1;
var stopReason = "maxEntries";
outer: while (values.length < maxEntries) {
	var n = fs.readSync(fd, buf, 0, CHUNK, pos);
	if (n < 8) { stopReason = "end of file"; break; }
	for (var i = 0; i + 8 <= n; i += 8) {
		var v = Number(buf.readBigUInt64LE(i));
		if (v < prev || v > size) { stopReason = "value " + v + " at 0x" + (pos + i).toString(16) + (v < prev ? " falls" : " exceeds file size"); break outer; }
		values.push(v);
		prev = v;
		if (values.length >= maxEntries) break outer;
	}
	pos += n - (n % 8);
}
fs.closeSync(fd);

var tableEnd = start + values.length * 8;
var deltas = values.slice(1).map(function (v, i) { return v - values[i]; });
var sorted = deltas.slice().sort(function (a, b) { return a - b; });
console.log("file size        " + size);
console.log("entries          " + values.length + "  (stop: " + stopReason + ")");
console.log("table end        0x" + tableEnd.toString(16) + " (" + tableEnd + ")");
console.log("first values     " + values.slice(0, 8).join(", "));
console.log("last values      " + values.slice(-4).join(", "));
console.log("last + tableEnd  " + (values[values.length - 1] + tableEnd) + "  (file size - that = " + (size - values[values.length - 1] - tableEnd) + ")");
console.log("zero deltas      " + deltas.filter(function (d) { return d === 0; }).length);
console.log("delta min/med/max " + sorted[0] + " / " + sorted[sorted.length >> 1] + " / " + sorted[sorted.length - 1]);
