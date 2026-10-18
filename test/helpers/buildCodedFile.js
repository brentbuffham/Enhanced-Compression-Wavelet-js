// test/helpers/buildCodedFile.js
//==========================================================
// Builds a synthetic ECW file with real coded blocks from chosen
// coefficients: coeff(record, band, subband, x, y) -> integer.
// Blocks are framed per FINDINGS.md (stream table + streams, band-
// major, LL only on record 0) and each stream is mode 6, or mode 5
// when all zero. Test-only.
//==========================================================

import { buildEcwFile } from "./buildEcwFile.js";

function ceilLevels(width, height, count, steps) {
	var list = [];
	for (var k = 0; k < count; k++) {
		var s = Math.pow(2, count - k);
		var st = steps ? steps(k) : { a: 1, b: 1, c: 1 };
		list.push({ level: k, width: Math.ceil(width / s), height: Math.ceil(height / s), a: st.a, b: st.b, c: st.c });
	}
	return list;
}

function encodeMode6(values) {
	var words = [];
	var run = 0;
	function flush() { while (run > 0) { var n = Math.min(run, 0x3FFF); words.push(0x8000 | n); run -= n; } }
	values.forEach(function (v) {
		if (v === 0) { run++; return; }
		flush();
		words.push(v > 0 ? v : 0x4000 | -v);
	});
	flush();
	var out = new Uint8Array(1 + words.length * 2);
	out[0] = 6;
	words.forEach(function (w, i) { out[1 + i * 2] = w & 0xFF; out[2 + i * 2] = w >> 8; });
	return out;
}

function frame(streams) {
	var header = (streams.length - 1) * 4;
	var total = header + streams.reduce(function (s, st) { return s + st.length; }, 0);
	var out = new Uint8Array(total);
	var view = new DataView(out.buffer);
	var rel = 0;
	streams.forEach(function (st, i) {
		if (i > 0) view.setUint32((i - 1) * 4, rel, false);
		out.set(st, header + rel);
		rel += st.length;
	});
	return out;
}

/**
 * @param {{width:number, height:number, levelCount:number, bands?:number, block?:number,
 *   coeff:function(number, number, string, number, number): number,
 *   steps?:function(number): {a:number, b:number, c:number}}} o
 *   steps gives each level record's a/b/c (per-band quantisation steps).
 * @returns {{bytes: Uint8Array, levels: Array}}
 */
export function buildCodedFile(o) {
	var bands = o.bands || 3;
	var block = o.block || 4;
	var levels = ceilLevels(o.width, o.height, o.levelCount, o.steps);
	var blocks = [];
	levels.forEach(function (lv, r) {
		var subbands = r === 0 ? ["LL", "LH", "HL", "HH"] : ["LH", "HL", "HH"];
		var rows = Math.ceil(lv.height / block), cols = Math.ceil(lv.width / block);
		for (var by = 0; by < rows; by++) {
			for (var bx = 0; bx < cols; bx++) {
				var pw = Math.min(block, lv.width - bx * block), ph = Math.min(block, lv.height - by * block);
				var streams = [];
				for (var b = 0; b < bands; b++) {
					subbands.forEach(function (sb) {
						var vals = [];
						for (var y = 0; y < ph; y++) for (var x = 0; x < pw; x++) vals.push(o.coeff(r, b, sb, bx * block + x, by * block + y));
						streams.push(vals.every(function (v) { return v === 0; }) ? Uint8Array.of(5) : encodeMode6(vals));
					});
				}
				blocks.push(frame(streams));
			}
		}
	});
	var bytes = buildEcwFile({
		headerOverrides: { width: o.width, height: o.height, levelCount: o.levelCount, bands: bands, blockWidth: block, blockHeight: block, levels: levels },
		blocks: blocks
	});
	return { bytes: bytes, levels: levels };
}
