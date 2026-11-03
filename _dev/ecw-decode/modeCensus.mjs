// _dev/ecw-decode/modeCensus.mjs
//==========================================================
// Stream mode census: reads every block's stream table in every
// ECW file given (default: everything under samples/), counts modes
// per level record and lists every stream in a mode the library does
// not decode, with block number, level, row, col and file offsets.
// The sample test only frames 2,000 spaced blocks, so a rare mode
// can hide from it; this is how a new mode gets found.
// The block data is read front to back in large chunks (the blocks
// sit back to back), which beats one small read per block.
// Usage: node _dev/ecw-decode/modeCensus.mjs [file|dir ...] [--list N] [--json out.json]
//==========================================================

import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels } from "../../src/format/EcwLevels.js";
import { parseBlockIndex, blockGrid, totalBlocks } from "../../src/format/EcwBlockIndex.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { createCensus, censusBlock, censusTotals, groupUnsupported, SUPPORTED_MODES } from "./censusLib.mjs";

var CHUNK = 64 * 1024 * 1024;
var HEADER_BYTES = 8192;

var args = process.argv.slice(2);
var listMax = 20;
var jsonOut = null;
var inputs = [];
for (var i = 0; i < args.length; i++) {
	if (args[i] === "--list") listMax = Number(args[++i]);
	else if (args[i] === "--json") jsonOut = args[++i];
	else inputs.push(args[i]);
}
if (!inputs.length) inputs.push(fileURLToPath(new URL("../../samples/", import.meta.url)));

function findEcw(path, out) {
	if (!fs.existsSync(path)) { console.error("not found: " + path); return out; }
	if (fs.statSync(path).isDirectory()) {
		fs.readdirSync(path).sort().forEach(function (name) { findEcw(join(path, name), out); });
	} else if (/\.ecw$/i.test(path)) out.push(path);
	return out;
}

function readAt(fd, buf, length, pos) {
	var got = 0;
	while (got < length) {
		var n = fs.readSync(fd, buf, got, length - got, pos + got);
		if (n === 0) break;
		got += n;
	}
	return got;
}

function hex(n) { return "0x" + n.toString(16).toUpperCase(); }
function pad(s, w) { s = String(s); return s.length >= w ? s : " ".repeat(w - s.length) + s; }

function surveyFile(path) {
	var t0 = performance.now();
	var fd = fs.openSync(path, "r");
	try {
		var size = fs.fstatSync(fd).size;
		var head = Buffer.alloc(Math.min(HEADER_BYTES, size));
		readAt(fd, head, head.length, 0);
		var source = new MemorySource(new Uint8Array(head.buffer, head.byteOffset, head.length));
		var header = parseHeader(source);
		var levels = parseLevels(source, header);
		var index = parseBlockIndex(source, header);
		var grid = blockGrid(header, levels);
		var total = totalBlocks(grid);
		var c = createCensus(header, levels, grid);
		var indexNotes = [];
		if (index.entryCount !== total + 1) indexNotes.push("index has " + index.entryCount + " entries, level grid needs " + (total + 1));

		// Step 1) Every block offset in one read (8 bytes per block)
		var entries = Math.min(index.entryCount, total + 1);
		var ib = Buffer.alloc(entries * 8);
		readAt(fd, ib, ib.length, index.offsetsStart);
		var offs = new Float64Array(entries);
		for (var k = 0; k < entries; k++) offs[k] = ib.readUInt32LE(k * 8) + ib.readUInt32LE(k * 8 + 4) * 4294967296;
		for (k = 1; k < entries; k++) {
			if (offs[k] < offs[k - 1]) { indexNotes.push("block offsets fall at entry " + k); entries = k; break; }
		}
		var dataEnd = index.dataStart + offs[entries - 1];
		if (dataEnd !== size) indexNotes.push("index ends at " + dataEnd + ", file size " + size);

		// Step 2) Walk the blocks front to back in big chunks
		var buf = Buffer.allocUnsafe(CHUNK);
		var record = 0, row = 0, col = 0;
		var n = 0, last = entries - 1;
		while (n < last) {
			var chunkStart = index.dataStart + offs[n];
			var want = Math.min(Math.max(CHUNK, index.dataStart + offs[n + 1] - chunkStart), size - chunkStart);
			if (want > buf.length) buf = Buffer.allocUnsafe(want);
			var got = readAt(fd, buf, want, chunkStart);
			var chunkEnd = chunkStart + got;
			if (index.dataStart + offs[n + 1] > chunkEnd) { indexNotes.push("block " + n + " runs past the end of the file"); break; }
			while (n < last && index.dataStart + offs[n + 1] <= chunkEnd) {
				var bs = index.dataStart + offs[n];
				censusBlock(c, record, row, col, n, buf, bs - chunkStart, index.dataStart + offs[n + 1] - chunkStart, bs);
				n++;
				if (++col === grid[record].cols) { col = 0; if (++row === grid[record].rows) { row = 0; record++; } }
			}
		}
		return { path: path, size: size, header: header, census: c, indexNotes: indexNotes, seconds: (performance.now() - t0) / 1000 };
	} finally {
		fs.closeSync(fd);
	}
}

function printReport(r) {
	var c = r.census, h = r.header, t = censusTotals(c);
	var modes = Object.keys(t.modes).map(Number).sort(function (a, b) { return a - b; });
	console.log("\n=== " + r.path);
	console.log(h.width + " x " + h.height + ", " + h.bands + " band(s), " + c.levels.length + " level records, " +
		t.blocks + " blocks, " + r.size + " bytes, " + r.seconds.toFixed(1) + " s (" + (r.size / 1048576 / r.seconds).toFixed(0) + " MB/s)");
	r.indexNotes.forEach(function (s) { console.log("index: " + s); });
	if (!r.indexNotes.length) console.log("index: ends exactly at the file size");
	console.log("supported modes: " + SUPPORTED_MODES.join(", "));
	console.log("\nrecord  size              grid        blocks   " + modes.map(function (m) { return pad("mode " + m, 11); }).join(""));
	c.levels.forEach(function (lv) {
		console.log(pad(lv.record, 6) + "  " + (lv.width + "x" + lv.height).padEnd(16) + "  " + (lv.cols + "x" + lv.rows).padEnd(10) +
			pad(lv.blocks, 8) + "   " + modes.map(function (m) { return pad(lv.modes[m], 11); }).join(""));
	});
	console.log("\nmode  streams      share     in edge blocks  levels");
	modes.forEach(function (m) {
		var x = t.modes[m];
		console.log(pad(m, 4) + pad(x.streams, 10) + pad((100 * x.streams / t.streams).toFixed(4) + "%", 11) + pad(x.edge, 17) + "  " +
			x.levels.join(",") + (c.supported[m] ? "" : "   <- not decoded"));
	});
	console.log("\nframing errors: " + c.errors.length);
	c.errors.slice(0, listMax).forEach(function (e) {
		console.log("  block " + e.block + " (record " + e.record + " row " + e.row + " col " + e.col + ") at " + hex(e.blockOffset) + ": " + e.message + " (" + hex(e.at) + ")");
	});
	console.log("unsupported streams: " + c.unsupported.length);
	if (!c.unsupported.length) return;
	console.log("  by mode / record / row:");
	groupUnsupported(c).forEach(function (g) {
		console.log("    mode " + g.mode + " record " + g.record + " row " + g.row + ": " + g.streams + " streams in " + g.blocks +
			" blocks, cols " + g.colMin + ".." + g.colMax + ", slots " + g.slots.join(" / ") + ", shapes " + g.shapes.join(" ") +
			", " + g.lengthMin + ".." + g.lengthMax + " bytes");
	});
	console.log("  first " + Math.min(listMax, c.unsupported.length) + ":");
	c.unsupported.slice(0, listMax).forEach(function (u) {
		console.log("    block " + u.block + " record " + u.record + " row " + u.row + " col " + u.col + " (" + u.pw + "x" + u.ph +
			") stream " + u.stream + " b" + u.band + " " + u.subband + " mode " + u.mode + ": block " + hex(u.blockOffset) +
			", mode byte " + hex(u.modeOffset) + ", " + u.length + " bytes");
	});
}

var files = [];
inputs.forEach(function (p) { findEcw(p, files); });
var reports = [];
files.forEach(function (path) {
	try {
		var r = surveyFile(path);
		printReport(r);
		reports.push(r);
	} catch (err) {
		console.log("\n=== " + path + "\nfailed: " + (err.code ? err.code + ": " : "") + err.message);
	}
});
if (jsonOut) {
	fs.writeFileSync(jsonOut, JSON.stringify(reports.map(function (r) {
		var t = censusTotals(r.census);
		return {
			path: r.path, size: r.size, seconds: r.seconds, indexNotes: r.indexNotes, totals: t,
			levels: r.census.levels.map(function (lv) {
				var modes = {};
				for (var m = 0; m < 256; m++) if (lv.modes[m]) modes[m] = lv.modes[m];
				return { record: lv.record, width: lv.width, height: lv.height, cols: lv.cols, rows: lv.rows, blocks: lv.blocks, bytes: lv.bytes, modes: modes };
			}),
			errors: r.census.errors, unsupported: r.census.unsupported
		};
	}), null, 1));
	console.log("\nwrote " + jsonOut);
}
