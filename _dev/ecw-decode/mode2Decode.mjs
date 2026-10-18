// _dev/ecw-decode/mode2Decode.mjs
//==========================================================
// Hypothesis test for mode-2 streams:
//   u16 LE N = number of tree nodes
//   N tokens, pre-order: 0x00 internal; 0x80 + u16 LE word leaf;
//   0x4v / 0x5v / 0x6v short leaf
//   then the coded bitstream
// Tries bit order x which branch bit is "left" x short-leaf meaning,
// decodes every sampled mode-2 stream, and counts streams whose
// value count equals the block extent and that end in the last byte.
// Usage: node _dev/ecw-decode/mode2Decode.mjs <file> [samples]
//==========================================================

import { collectStreams } from "./mode2Bytes.mjs";

var SHORT_MAPS = {
	"4+ 6- 5z": { 4: "+", 6: "-", 5: "z" },
	"4+ 5- 6z": { 4: "+", 5: "-", 6: "z" },
	"4z 5+ 6-": { 4: "z", 5: "+", 6: "-" },
	"4+ 5z 6-": { 4: "+", 5: "z", 6: "-" }
};

function leafValues(kind, m) {
	if (kind === "+") return { value: m, run: 0 };
	if (kind === "-") return { value: -m, run: 0 };
	return { value: 0, run: m };
}

export function readTree(b, shortMap) {
	var N = b[0] | (b[1] << 8);
	var p = 2;
	var nodes = 0;
	function node() {
		if (p >= b.length) throw new Error("eof in tree");
		nodes++;
		var t = b[p++];
		if (t === 0) return { left: node(), right: node() };
		if (t === 0x80) {
			var w = b[p] | (b[p + 1] << 8);
			p += 2;
			return { leaf: leafValues(["+", "-", "z", "?"][w >> 14], w & 0x3FFF) };
		}
		return { leaf: leafValues(shortMap[t >> 4] || "?", t & 15) };
	}
	var root = node();
	if (nodes !== N) throw new Error("node count " + nodes + " != " + N);
	return { root: root, dataStart: p };
}

export function decodeMode2(b, count, opts) {
	var tree = readTree(b, opts.shortMap);
	var pos = tree.dataStart * 8;
	var end = b.length * 8;
	var values = [];
	while (values.length < count) {
		var n = tree.root;
		while (!n.leaf) {
			if (pos >= end) throw new Error("eof in data");
			var byte = b[pos >> 3];
			var bit = opts.lsb ? (byte >> (pos & 7)) & 1 : (byte >> (7 - (pos & 7))) & 1;
			pos++;
			n = (bit === opts.leftBit) ? n.left : n.right;
		}
		if (n.leaf.run) for (var k = 0; k < n.leaf.run; k++) values.push(0);
		else values.push(n.leaf.value);
	}
	return { values: values, spareBits: end - pos };
}

if (process.argv[1] && process.argv[1].endsWith("mode2Decode.mjs")) {
	var streams = collectStreams(process.argv[2], Number(process.argv[3] || 6000), 2, 1500);
	var results = [];
	Object.keys(SHORT_MAPS).forEach(function (mapName) {
		[true, false].forEach(function (lsb) {
			[0, 1].forEach(function (leftBit) {
				var exact = 0, over = 0, err = 0;
				streams.forEach(function (s) {
					try {
						var d = decodeMode2(s.bytes, s.count, { lsb: lsb, leftBit: leftBit, shortMap: SHORT_MAPS[mapName] });
						if (d.values.length === s.count && d.spareBits < 8) exact++;
						else over++;
					} catch (e) { err++; }
				});
				results.push({ map: mapName, lsb: lsb, leftBit: leftBit, exact: exact, over: over, err: err, of: streams.length });
			});
		});
	});
	results.sort(function (a, b) { return b.exact - a.exact; });
	results.slice(0, 5).forEach(function (r) { console.log(JSON.stringify(r)); });
}
