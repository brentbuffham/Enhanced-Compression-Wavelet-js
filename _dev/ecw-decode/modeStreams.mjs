// _dev/ecw-decode/modeStreams.mjs
//==========================================================
// Pulls every stream the census listed as not decoded (one mode),
// with the other streams of the same blocks for comparison, and
// prints a size survey: coefficient count, payload length, first
// bytes, and bits per coefficient for a few header lengths.
// Optionally writes them all to a JSON file (keep it in samples/).
// Usage: node _dev/ecw-decode/modeStreams.mjs <file.ecw> <census.json> <mode> [--out streams.json] [--show N]
//==========================================================

import fs from "node:fs";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels } from "../../src/format/EcwLevels.js";
import { parseBlockIndex, blockEntryWindow, blockByteRange } from "../../src/format/EcwBlockIndex.js";
import { splitBlockStreams } from "../../src/format/EcwBlockFrame.js";
import { MemorySource } from "../../src/io/MemorySource.js";

var args = process.argv.slice(2);
var file = args[0], censusPath = args[1], mode = Number(args[2]);
var out = null, show = 12;
for (var i = 3; i < args.length; i++) {
	if (args[i] === "--out") out = args[++i];
	else if (args[i] === "--show") show = Number(args[++i]);
}
if (!file || !censusPath || !Number.isInteger(mode)) {
	console.error("usage: modeStreams.mjs <file.ecw> <census.json> <mode> [--out streams.json] [--show N]");
	process.exit(2);
}

var fd = fs.openSync(file, "r");
var size = fs.fstatSync(fd).size;
function read(start, length) { var b = Buffer.alloc(length); fs.readSync(fd, b, 0, length, start); return new Uint8Array(b.buffer, b.byteOffset, length); }
var head = new MemorySource(read(0, Math.min(8192, size)));
var header = parseHeader(head);
parseLevels(head, header);
var index = parseBlockIndex(head, header);

var report = JSON.parse(fs.readFileSync(censusPath, "utf8")).find(function (r) { return r.size === size; });
if (!report) { console.error("no census entry with this file's size"); process.exit(1); }
var wanted = report.unsupported.filter(function (u) { return u.mode === mode; });
var byBlock = new Map();
wanted.forEach(function (u) { if (!byBlock.has(u.block)) byBlock.set(u.block, u); });

var blocks = [];
byBlock.forEach(function (u, n) {
	var w = blockEntryWindow(index, n);
	var r = blockByteRange(index, n, read(w.start, 16), size);
	var streams = splitBlockStreams(read(r.start, r.end - r.start), header.bands, u.record, { offset: r.start, keepUnsupported: true });
	blocks.push({
		block: n, record: u.record, row: u.row, col: u.col, pw: u.pw, ph: u.ph, offset: r.start,
		streams: streams.map(function (s) { return { band: s.band, subband: s.subband, mode: s.mode, hex: Buffer.from(s.bytes).toString("hex") }; })
	});
});
fs.closeSync(fd);

function hex(b, n) { return Buffer.from(b.subarray(0, n)).toString("hex").replace(/(..)/g, "$1 ").trim(); }
var rows = [];
blocks.forEach(function (b) {
	b.streams.forEach(function (s, k) {
		if (s.mode !== mode) return;
		var bytes = Buffer.from(s.hex, "hex");
		rows.push({ b: b, k: k, s: s, bytes: bytes, count: b.pw * b.ph });
	});
});
console.log(rows.length + " mode " + mode + " streams in " + blocks.length + " blocks");
console.log("block  rec row col  shape  slot     count  payload  bits/coef for header 0..4 bytes       first bytes");
rows.slice(0, show).forEach(function (r) {
	var bpc = [0, 1, 2, 3, 4].map(function (h) { return ((r.bytes.length - h) * 8 / r.count).toFixed(2); }).join(" ");
	console.log(String(r.b.block).padStart(5) + " " + String(r.b.record).padStart(4) + String(r.b.row).padStart(4) + String(r.b.col).padStart(4) + "  " +
		(r.b.pw + "x" + r.b.ph).padEnd(6) + " b" + r.s.band + " " + r.s.subband + "  " + String(r.count).padStart(6) + String(r.bytes.length).padStart(9) + "  " + bpc + "   " + hex(r.bytes, 12));
});
// byte-position histograms over the first 6 bytes
for (var p = 0; p < 6; p++) {
	var counts = new Map();
	rows.forEach(function (r) { var v = r.bytes[p]; counts.set(v, (counts.get(v) || 0) + 1); });
	var top = Array.from(counts.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);
	console.log("byte " + p + ": " + counts.size + " distinct; top " + top.map(function (e) { return e[0].toString(16).padStart(2, "0") + "×" + e[1]; }).join(" "));
}
if (out) {
	fs.writeFileSync(out, JSON.stringify({ mode: mode, bands: header.bands, blocks: blocks }, null, 1));
	console.log("wrote " + out);
}
