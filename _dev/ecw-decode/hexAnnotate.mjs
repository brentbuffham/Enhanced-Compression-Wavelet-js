// _dev/ecw-decode/hexAnnotate.mjs
//==========================================================
// Annotated hex dump of a byte range.
// Usage: node _dev/ecw-decode/hexAnnotate.mjs <file> <start> <length> [annotations.json]
// annotations.json: [{ "offset": 6, "length": 4, "label": "width u32 BE" }]
// Numbers accept 0x hex. Only the requested range is read.
//==========================================================

import fs from "node:fs";
import { formatHexRows, parseNumberArg, readFileRange } from "./probeLib.mjs";

var args = process.argv.slice(2);
if (args.length < 3) {
	console.error("usage: hexAnnotate.mjs <file> <start> <length> [annotations.json]");
	process.exit(2);
}
var start = parseNumberArg(args[1]);
var bytes = readFileRange(fs, args[0], start, parseNumberArg(args[2]));
var annotations = args[3] ? JSON.parse(fs.readFileSync(args[3], "utf8")) : [];
console.log(" ".repeat(12) + Array.from({ length: 16 }, function (_, i) { return i.toString(16).padStart(2, " "); }).join(" "));
formatHexRows(bytes, start, annotations).forEach(function (row) { console.log(row); });
