// _dev/ecw-decode/mode3Oracle.mjs
//==========================================================
// Black-box oracle for the mode-3 stream format: builds a mode-3
// stream byte by byte with the structure worked out so far (Schindler
// range coder; raw 16-bit values after non-negative coefficients; a
// context nibble and a table symbol after negative ones), puts it in a
// tiny crafted ECW (one level, 64x4 coefficients, band 0 LH), lets the
// ECW SDK decode it through QGIS GDAL (file in, pixels out) and reads
// the coefficients back with groundTruth.mjs. Nothing inside the SDK is
// inspected. Outputs stay in the gitignored samples/synth/.
// Usage: node _dev/ecw-decode/mode3Oracle.mjs validate
//        node _dev/ecw-decode/mode3Oracle.mjs probe <prefix values csv> <position16> [<position16> ...]
//==========================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { craftEcw, sdkDecode } from "./craft.mjs";

var W = 64, H = 4, N = W * H;
var TOP = 0x80000000, SHIFT = 23, BOTTOM = 1 << 23;

// Schindler encoder state (header byte = mode byte 3, dropped from the payload)
function Enc() { return { low: 0, range: TOP, buffer: 3, help: 0, out: [], count: 0 }; }
var NORM_LT = process.env.NORM_LT === "1";
function norm(s) {
	while (NORM_LT ? s.range < BOTTOM : s.range <= BOTTOM) {
		if (s.low < 0xff * BOTTOM) { s.out.push(s.buffer & 0xff); for (; s.help; s.help--) s.out.push(0xff); s.buffer = (s.low >>> SHIFT) & 0xff; }
		else if (s.low >= TOP) { s.out.push((s.buffer + 1) & 0xff); for (; s.help; s.help--) s.out.push(0); s.buffer = (s.low >>> SHIFT) & 0xff; }
		else s.help++;
		s.range = (s.range * 256) >>> 0; s.low = ((s.low * 256) % TOP) >>> 0; s.count++;
	}
}
function ef(s, sf, lt, tot) { norm(s); var r = Math.floor(s.range / tot), t = r * lt; s.low += t; if (lt + sf < tot) s.range = r * sf; else s.range -= t; }
function finish(s) {
	norm(s);
	var t = (s.low >>> SHIFT) + 1;
	if (t > 0xff) { s.out.push((s.buffer + 1) & 0xff); for (; s.help; s.help--) s.out.push(0); }
	else { s.out.push(s.buffer & 0xff); for (; s.help; s.help--) s.out.push(0xff); }
	s.out.push(t & 0xff);
	var payload = s.out.slice(1);
	// padding so a decoder that reads past our data still has bytes, then the length trailer
	for (var k = 0; k < (Number(process.env.PAD) || 64); k++) payload.push(0);
	var len = payload.length + 3;
	payload.push((len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
	return Uint8Array.from([3].concat(payload));
}

var HI = { lt: 904, sf: 60, tot: 1024 }, LO = { lt: 3646, sf: 225, tot: 4096 };
// Encode coefficients with the established structure (static tables: exact for the first two table uses)
function encodeValues(s, vals) {
	var prev = 0;
	vals.forEach(function (v) {
		if (prev >= 0) ef(s, 1, v & 0xff, 65536);
		else {
			var nib = Math.min(-prev, 16) - 1;
			ef(s, 1, nib, 16);
			var t = nib === 15 ? HI : LO;
			ef(s, t.sf, t.lt, t.tot);
			ef(s, 1, v & 0xff, 256);
		}
		prev = v;
	});
	return prev;
}

function craftAndRead(name, stream) {
	// ORACLE_TAG keeps parallel sessions from overwriting each other's files
	if (process.env.ORACLE_TAG) name = process.env.ORACLE_TAG + "-" + name;
	var bytes = craftEcw({ width: 2 * W, height: 2 * H, levelCount: 1, bands: 3, block: 64,
		coeff: function (r, b, sb) { return b === 0 && sb === "LL" ? 100 : 0; },
		streamOverride: function (r, b, sb) { return b === 0 && sb === "LH" ? stream : null; } });
	var dec = sdkDecode(name, bytes);
	// back-solve band 0 LH of block 0 from the SDK pixels (stream index 1)
	var out = path.join(path.dirname(dec.ecwPath), name + ".gt.json");
	var r = spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "groundTruth.mjs"), dec.ecwPath, "0", "1", out], { encoding: "utf8" });
	if (r.status !== 0) throw new Error("groundTruth failed: " + r.stderr + r.stdout);
	var g = JSON.parse(fs.readFileSync(out, "utf8"));
	return { plane: g.plane, exact: g.exact, mismatches: g.mismatches };
}

var cmd = process.argv[2];
if (cmd === "validate") {
	// only two table uses, then non-negative values (raw): our encoder is exact here
	var vals = [-5, -20, 30, 1, 2, 3, 0, 7, 50, 12];
	while (vals.length < N) vals.push((vals.length * 7) % 40);
	var s = Enc(); encodeValues(s, vals);
	var got = craftAndRead("m3-validate", finish(s));
	var bad = [];
	for (var i = 0; i < N; i++) if (Math.abs(got.plane[i] - vals[i]) > 1) bad.push(i + ":" + vals[i] + "→" + got.plane[i]);
	console.log("SDK pixels reproduced: " + (got.exact ? "exactly" : got.mismatches + " mismatches") + "; coefficients differing by >1: " + bad.length + (bad.length ? " " + bad.slice(0, 10).join(" ") : ""));
	console.log("first 12 read back: " + got.plane.slice(0, 12).join(" "));
} else if (cmd === "word") {
	// first unit: a chosen raw 16-bit word, then raw small positives (prev >= 0 path)
	process.argv.slice(3).forEach(function (w) {
		var word = Number(w), s = Enc();
		ef(s, 1, word, 65536);
		for (var k = 0; k < 12; k++) ef(s, 1, 5 + k, 65536);
		var got = craftAndRead("m3-word", finish(s));
		console.log("word 0x" + word.toString(16).padStart(4, "0") + " -> SDK coefficients: " + got.plane.slice(0, 16).join(" ") + (got.exact ? "" : "  (" + got.mismatches + " px off)"));
	});
} else if (cmd === "wordnib") {
	// first unit: raw 16-bit word, then a 4-bit symbol k, then raw small positives
	var word = Number(process.argv[3]);
	process.argv.slice(4).map(Number).forEach(function (k) {
		var s = Enc();
		ef(s, 1, word, 65536); ef(s, 1, k, 16);
		for (var q = 0; q < 8; q++) ef(s, 1, 5 + q, 65536);
		var got = craftAndRead("m3-wordnib", finish(s));
		console.log("word 0x" + word.toString(16) + " then 4-bit " + String(k).padStart(2) + " -> " + got.plane.slice(0, 10).join(" ") + (got.exact ? "" : "  (" + got.mismatches + " px off)"));
	});
} else if (cmd === "transplant") {
	// a real mode-3 stream (from modeStreams.mjs JSON) dropped into the crafted block
	var J = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
	var blk = J.blocks.find(function (b) { return b.block === Number(process.argv[4]); });
	var st = blk.streams[Number(process.argv[5])];
	var bytes = Uint8Array.from([3].concat(Array.from(Buffer.from(st.hex, "hex"))));
	var got = craftAndRead("m3-transplant", bytes);
	console.log("SDK on transplanted stream: " + got.plane.slice(0, 24).join(" ") + (got.exact ? "" : "  (" + got.mismatches + " px off)"));
	if (process.argv[6]) { var g = JSON.parse(fs.readFileSync(process.argv[6], "utf8")); console.log("ground truth (real file):   " + g.plane.slice(0, 24).join(" ")); var d = 0; for (var i = 0; i < 256; i++) if (Math.abs(g.plane[i] - got.plane[i]) > 1) d++; console.log("coefficients differing by >1: " + d + " of 256"); }
} else if (cmd === "seq") {
	// a sequence of steps: "r:<16-bit>" raw unit, "n:<k>" 4-bit symbol, "hi:<byte>" hi-table literal, "lo:<byte>" lo-table literal
	process.argv.slice(3).forEach(function (spec) {
		var s = Enc();
		spec.split(",").forEach(function (step) {
			var kv = step.split(":"), v = Number(kv[1]);
			if (kv[0] === "r") ef(s, 1, v & 0xffff, 65536);
			else if (kv[0] === "n") ef(s, 1, v, 16);
			else if (kv[0] === "hi") { ef(s, HI.sf, HI.lt, HI.tot); ef(s, 1, v & 0xff, 256); }
			else if (kv[0] === "lo") { ef(s, LO.sf, LO.lt, LO.tot); ef(s, 1, v & 0xff, 256); }
			else if (kv[0] === "f") ef(s, Number(kv[1]), Number(kv[2]), Number(kv[3]));   // f:<width>:<start>:<total>
			else if (kv[0] === "b") ef(s, 1, v & 0xff, 256);                                // b:<byte> (uniform 8 bits)
		});
		var fill = process.env.FILL === undefined ? 8 : Number(process.env.FILL);
		for (var q = 0; q < fill; q++) ef(s, 1, 0, 65536);
		var got = craftAndRead("m3-seq", finish(s));
		console.log(spec.slice(0, 30) + "... -> " + got.plane.slice(0, 24).join(" ") + (got.exact ? "" : "  (" + got.mismatches + " px off)"));
	});
} else if (cmd === "probe") {
	var prefix = process.argv[3].split(",").map(Number);
	process.argv.slice(4).map(Number).forEach(function (pos) {
		var s = Enc();
		var last = encodeValues(s, prefix);
		if (last >= 0) throw new Error("prefix must end with a negative value so the next coefficient goes through a table");
		ef(s, 1, Math.min(-last, 16) - 1, 16);
		ef(s, 1, pos, 65536);               // the position inside the table, 1/65536 units
		for (var k = 0; k < 8; k++) ef(s, 1, 0, 65536);
		var got = craftAndRead("m3-probe", finish(s));
		console.log("pos " + pos + " (" + (pos / 65536).toFixed(5) + "): coef " + prefix.length + " = " + got.plane[prefix.length] + "   next: " + got.plane.slice(prefix.length + 1, prefix.length + 5).join(" ") + (got.exact ? "" : "  (" + got.mismatches + " px off)"));
	});
}
