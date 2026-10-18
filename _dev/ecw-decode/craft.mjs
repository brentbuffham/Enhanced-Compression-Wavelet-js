// _dev/ecw-decode/craft.mjs
//==========================================================
// Crafts small ECW files with chosen coefficients so the ECW SDK
// (via QGIS GDAL) can decode them as a black box: impulse responses
// of the SDK decoder, compared with ours. No encoder involved.
// The fixed header (0x00-0x58) comes from the private sample so the
// still-unknown bytes keep real values; dimensions, bands, block size
// and the level table are overwritten. Streams are mode 6 / mode 5.
// Output goes to the gitignored samples/synth/.
//==========================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findSample, readRange } from "../../test/helpers/samples.js";
import { readTiff } from "../../test/helpers/readTiff.js";
import { encodeMode2 } from "../../test/helpers/encodeMode2.js";

var QGIS_BIN = process.env.QGIS_BIN || "C:\\Program Files\\QGIS 4.2.3\\bin";
var GDAL_APPS = path.join(QGIS_BIN, "..", "apps", "gdal");
var ENV = Object.assign({}, process.env, {
	PATH: QGIS_BIN + path.delimiter + process.env.PATH,
	GDAL_DRIVER_PATH: path.join(GDAL_APPS, "lib", "gdalplugins"),
	GDAL_DATA: path.join(GDAL_APPS, "share", "gdal")
});

function encodeMode6(values) {
	var words = [], run = 0;
	function flush() { while (run > 0) { var n = Math.min(run, 0x3FFF); words.push(0x8000 | n); run -= n; } }
	values.forEach(function (v) { if (v === 0) { run++; return; } flush(); words.push(v > 0 ? v : 0x4000 | -v); });
	flush();
	var out = new Uint8Array(1 + words.length * 2);
	out[0] = 6;
	words.forEach(function (w, i) { out[1 + i * 2] = w & 0xFF; out[2 + i * 2] = w >> 8; });
	return out;
}

// Values -> mode-2 symbols: zero runs and signed literals
function toSymbols(vals) {
	var out = [], run = 0;
	function flush() { while (run > 0) { var n = Math.min(run, 0x3FFF); out.push({ kind: "z", m: n }); run -= n; } }
	vals.forEach(function (v) { if (v === 0) { run++; return; } flush(); out.push({ kind: v > 0 ? "+" : "-", m: Math.abs(v) }); });
	flush();
	return out;
}

function frame(streams) {
	var header = (streams.length - 1) * 4;
	var total = header + streams.reduce(function (s, st) { return s + st.length; }, 0);
	var out = new Uint8Array(total), view = new DataView(out.buffer), rel = 0;
	streams.forEach(function (st, i) { if (i > 0) view.setUint32((i - 1) * 4, rel, false); out.set(st, header + rel); rel += st.length; });
	return out;
}

/**
 * @param {{width:number, height:number, levelCount:number, bands?:number, block?:number,
 *   steps?:function(number):{a:number,b:number,c:number},
 *   coeff:function(number, number, string, number, number):number, mode?:number}} o
 *   mode 2 writes Huffman streams (test encoder), default 6 writes run-length words.
 * @returns {Uint8Array} ECW file bytes
 */
export function craftEcw(o) {
	var bands = o.bands || 3, block = o.block || 64;
	var template = readRange(findSample().ecwPath, 0, 0x59);
	var levels = [];
	for (var k = 0; k < o.levelCount; k++) {
		var s = Math.pow(2, o.levelCount - k), st = o.steps ? o.steps(k) : { a: 1, b: 1, c: 1 };
		levels.push({ width: Math.ceil(o.width / s), height: Math.ceil(o.height / s), a: st.a, b: st.b, c: st.c });
	}
	var blocks = [];
	levels.forEach(function (lv, r) {
		var subbands = r === 0 ? ["LL", "LH", "HL", "HH"] : ["LH", "HL", "HH"];
		for (var by = 0; by < Math.ceil(lv.height / block); by++) for (var bx = 0; bx < Math.ceil(lv.width / block); bx++) {
			var pw = Math.min(block, lv.width - bx * block), ph = Math.min(block, lv.height - by * block), streams = [];
			for (var b = 0; b < bands; b++) subbands.forEach(function (sb) {
				var vals = [];
				for (var y = 0; y < ph; y++) for (var x = 0; x < pw; x++) vals.push(o.coeff(r, b, sb, bx * block + x, by * block + y));
				if (vals.every(function (v) { return v === 0; })) { streams.push(Uint8Array.of(5)); return; }
				if (o.mode === 2) { var payload = encodeMode2(toSymbols(vals)); var st = new Uint8Array(1 + payload.length); st[0] = 2; st.set(payload, 1); streams.push(st); return; }
				streams.push(encodeMode6(vals));
			});
			blocks.push(frame(streams));
		}
	});
	var tableEnd = 0x59 + 21 * levels.length;
	var entries = blocks.length + 1;
	var bodyLength = 1 + 8 * entries;
	var dataLength = blocks.reduce(function (s, b) { return s + b.length; }, 0);
	var out = new Uint8Array(tableEnd + 4 + bodyLength + dataLength);
	var view = new DataView(out.buffer);
	out.set(template, 0);
	out[0x04] = levels.length;
	view.setUint32(0x06, o.width, false);
	view.setUint32(0x0A, o.height, false);
	view.setUint16(0x0E, bands, false);
	view.setUint16(0x12, block, false);
	view.setUint16(0x14, block, false);
	levels.forEach(function (lv, i) {
		var p = 0x59 + 21 * i;
		out[p] = i;
		view.setUint32(p + 1, lv.width, false); view.setUint32(p + 5, lv.height, false);
		view.setUint32(p + 9, lv.a, false); view.setUint32(p + 13, lv.b, false); view.setUint32(p + 17, lv.c, false);
	});
	view.setUint32(tableEnd, bodyLength, false);
	out[tableEnd + 4] = 1;
	var pos = tableEnd + 5, off = 0;
	for (var e = 0; e < entries; e++) {
		view.setUint32(pos, off % 4294967296, true); view.setUint32(pos + 4, Math.floor(off / 4294967296), true);
		pos += 8;
		if (e < blocks.length) off += blocks[e].length;
	}
	blocks.forEach(function (b) { out.set(b, pos); pos += b.length; });
	return out;
}

/** Write bytes to samples/synth/<name>.ecw, decode with GDAL at full size, return the TIFF pixels. */
export function sdkDecode(name, bytes, extraArgs) {
	var dir = path.join(path.dirname(findSample().ecwPath), "synth");
	fs.mkdirSync(dir, { recursive: true });
	var ecw = path.join(dir, name + ".ecw"), tif = path.join(dir, name + ".sdk.tif");
	fs.writeFileSync(ecw, bytes);
	var r = spawnSync(path.join(QGIS_BIN, "gdal_translate.exe"), ["-q", "-of", "GTiff", "-co", "COMPRESS=NONE", "-co", "INTERLEAVE=PIXEL"].concat(extraArgs || [], [ecw, tif]), { env: ENV, encoding: "utf8" });
	if (r.status !== 0) throw new Error("gdal_translate failed: " + r.stderr);
	return { ecwPath: ecw, pixels: readTiff(new Uint8Array(fs.readFileSync(tif))) };
}
