// _dev/ecw-decode/byteStats.mjs
//==========================================================
// Entropy and top byte values for a range: compressed data sits
// near 8 bits/byte, tables and headers far lower.
// Usage: node _dev/ecw-decode/byteStats.mjs <file> <start> <length>
//==========================================================

import fs from "node:fs";
import { histogramTop, parseNumberArg, readFileRange, shannonEntropy } from "./probeLib.mjs";

var args = process.argv.slice(2);
if (args.length < 3) {
	console.error("usage: byteStats.mjs <file> <start> <length>");
	process.exit(2);
}
var start = parseNumberArg(args[1]);
var bytes = readFileRange(fs, args[0], start, parseNumberArg(args[2]));
console.log("range 0x" + start.toString(16) + " + " + bytes.length + " bytes");
console.log("entropy " + shannonEntropy(bytes).toFixed(3) + " bits/byte");
histogramTop(bytes, 16).forEach(function (h) {
	console.log("  0x" + h.value.toString(16).padStart(2, "0") + "  " + h.count);
});
