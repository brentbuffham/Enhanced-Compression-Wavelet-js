// _dev/ecw-decode/mode2Verify.mjs
// Verify mode-2 decoding (LSB-first, bit 0 = left) over many streams for each short-token mapping.
// A stream passes when decoding stops exactly at the block's value count and every leftover bit is 0.
// Usage: node _dev/ecw-decode/mode2Verify.mjs <file> [samples] [limit]
import { collectStreams } from "./mode2Bytes.mjs";
import { readTree } from "./mode2Decode.mjs";
var streams = collectStreams(process.argv[2], Number(process.argv[3] || 20000), 2, Number(process.argv[4] || 6000));
var maps = { "4+ 5- 6z": { 4: "+", 5: "-", 6: "z" }, "4+ 6- 5z": { 4: "+", 6: "-", 5: "z" }, "4z 5+ 6-": { 4: "z", 5: "+", 6: "-" }, "all values": { 4: "+", 5: "-", 6: "+" } };
Object.keys(maps).forEach(function (k) {
	var res = { pass: 0, overshoot: 0, eof: 0, nonzeroTail: 0 };
	streams.forEach(function (s) {
		var b = s.bytes, t = readTree(b, maps[k]), pos = t.dataStart * 8, end = b.length * 8, n = 0;
		try {
			while (n < s.count) { var node = t.root; while (!node.leaf) { if (pos >= end) throw 0; node = ((b[pos >> 3] >> (pos & 7)) & 1) === 0 ? node.left : node.right; pos++; } n += node.leaf.run || 1; }
		} catch (e) { res.eof++; return; }
		if (n !== s.count) { res.overshoot++; return; }
		for (var p = pos; p < end; p++) if ((b[p >> 3] >> (p & 7)) & 1) { res.nonzeroTail++; return; }
		res.pass++;
	});
	console.log(k.padEnd(11), "streams", streams.length, JSON.stringify(res));
});
