// test/helpers/encodeMode2.js
//==========================================================
// Test-only mode-2 encoder (FINDINGS.md "mode 2 streams"):
// builds a right-leaning chain Huffman tree over the distinct
// symbols, writes it in pre-order (0x00 internal, short 0x4v/0x5v/0x6v
// leaves for magnitudes <= 15, else 0x80 + u16 LE word), then the
// codes LSB-first, then one extra byte like the real encoder.
// A symbol is { kind: "+" | "-" | "z", m }.
//==========================================================

function key(s) { return s.kind + s.m; }

function leafToken(s, forceLong) {
	var tag = s.kind === "+" ? 0 : s.kind === "-" ? 1 : 2;
	if (!forceLong && s.m >= 1 && s.m <= 15) return [0x40 | (tag << 4) | s.m];
	var w = (tag << 14) | s.m;
	return [0x80, w & 0xFF, w >> 8];
}

/**
 * @param {Array<{kind:string, m:number}>} symbols - Sequence to encode.
 * @param {{forceLong?: boolean}} [opts]
 * @returns {Uint8Array} mode-2 payload (without the mode byte)
 */
export function encodeMode2(symbols, opts) {
	var forceLong = opts && opts.forceLong;
	var distinct = [];
	var index = {};
	symbols.forEach(function (s) { if (index[key(s)] === undefined) { index[key(s)] = distinct.length; distinct.push(s); } });
	var k = distinct.length;
	var tokens = [];
	var codes = [];
	for (var i = 0; i < k; i++) {
		if (i < k - 1) tokens.push(0x00);
		tokens = tokens.concat(leafToken(distinct[i], forceLong));
		// chain: leaf i is the left child of the i-th internal node
		codes.push(i < k - 1 ? "1".repeat(i) + "0" : "1".repeat(k - 1));
	}
	var nodes = 2 * k - 1;
	var bits = symbols.map(function (s) { return codes[index[key(s)]]; }).join("");
	var dataBytes = new Uint8Array(Math.ceil(bits.length / 8) + 1);
	for (var b = 0; b < bits.length; b++) if (bits[b] === "1") dataBytes[b >> 3] |= 1 << (b & 7);
	var out = new Uint8Array(2 + tokens.length + dataBytes.length);
	out[0] = nodes & 0xFF;
	out[1] = nodes >> 8;
	out.set(tokens, 2);
	out.set(dataBytes, 2 + tokens.length);
	return out;
}
