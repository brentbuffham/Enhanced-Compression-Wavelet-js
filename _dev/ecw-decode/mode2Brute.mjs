// _dev/ecw-decode/mode2Brute.mjs
//==========================================================
// Brute force for a small mode-2 stream: take its table tokens as
// the leaf symbols, try every prefix-code assignment (all binary
// tree shapes x leaf orders) and both bit orders, decode the bits
// after the table, and keep codes that yield exactly `count`
// values ending within the last byte of the stream.
// Usage: node _dev/ecw-decode/mode2Brute.mjs <hexPayload> <count>
//==========================================================

var hex = process.argv[2].replace(/\s+/g, "");
var count = Number(process.argv[3]);
var bytes = Uint8Array.from(hex.match(/../g).map(function (h) { return parseInt(h, 16); }));
var N = bytes[0] | (bytes[1] << 8);

export function tokenize(b, start, end) {
	var toks = [];
	var p = start;
	while (p < end) {
		var t = b[p];
		if (t === 0x80) { var w = b[p + 1] | (b[p + 2] << 8); toks.push(wordValues(w)); p += 3; }
		else if (t === 0) { toks.push([0]); p++; }
		else { toks.push(byteValues(t)); p++; }
	}
	return toks;
}
function wordValues(w) {
	var m = w & 0x3FFF, tag = w >> 14;
	if (tag === 0) return [m];
	if (tag === 1) return [-m];
	return new Array(m).fill(0);
}
function byteValues(t) {
	var m = t & 15, kind = t >> 4;
	if (kind === 4) return [m];
	if (kind === 6) return [-m];
	return new Array(m).fill(0); // 0x5v: assume short zero run
}

// All full binary trees with k leaves, as arrays of leaf code strings in left-to-right order
function shapes(k) {
	if (k === 1) return [[""]];
	var out = [];
	for (var left = 1; left < k; left++) {
		shapes(left).forEach(function (L) {
			shapes(k - left).forEach(function (R) {
				out.push(L.map(function (c) { return "0" + c; }).concat(R.map(function (c) { return "1" + c; })));
			});
		});
	}
	return out;
}
function permutations(arr) {
	if (arr.length <= 1) return [arr];
	var out = [];
	arr.forEach(function (x, i) {
		permutations(arr.slice(0, i).concat(arr.slice(i + 1))).forEach(function (p) { out.push([x].concat(p)); });
	});
	return out;
}

var toks = tokenize(bytes, 4, 4 + N);
var data = bytes.subarray(4 + N);
var totalBits = data.length * 8;
var solutions = [];
[false, true].forEach(function (lsb) {
	var bits = [];
	for (var i = 0; i < totalBits; i++) bits.push(lsb ? (data[i >> 3] >> (i & 7)) & 1 : (data[i >> 3] >> (7 - (i & 7))) & 1);
	var bitStr = bits.join("");
	shapes(toks.length).forEach(function (codes) {
		permutations(toks.map(function (_, i) { return i; })).forEach(function (order) {
			var map = {};
			codes.forEach(function (c, i) { map[c] = order[i]; });
			var pos = 0, produced = 0, cur = "";
			while (pos < totalBits && produced < count) {
				cur += bitStr[pos++];
				if (map[cur] !== undefined) { produced += toks[map[cur]].length; cur = ""; }
				if (cur.length > 16) break;
			}
			if (produced === count && totalBits - pos < 8) {
				solutions.push({ lsb: lsb, codes: codes.map(function (c, i) { return c + "=" + order[i]; }).join(" "), usedBits: pos, totalBits: totalBits });
			}
		});
	});
});
console.log("tokens", toks.map(function (t) { return t.length > 1 ? "z" + t.length : String(t[0]); }).join(" "));
console.log("solutions", solutions.length);
solutions.filter(function (s) { return !process.argv[4] || s.codes.split(" ").indexOf(process.argv[4]) >= 0; }).slice(0, 40).forEach(function (s) { console.log(JSON.stringify(s)); });
