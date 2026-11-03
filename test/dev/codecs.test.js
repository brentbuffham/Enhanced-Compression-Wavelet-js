// test/dev/codecs.test.js
//==========================================================
// The probe decoders in _dev/ecw-decode/codecs.mjs must be right
// before a "not this format" result means anything: hand-built
// vectors from each format's description, raw LZMA vectors made by
// Python's lzma module, and round trips through small reference
// encoders for the entropy coders.
// Run with: node --test test/dev/codecs.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lz4Block, lzf, fastlz, snappy, lzss, lzw, lzo1x, lzmaRaw, wnc, subbotin, universal } from "../../_dev/ecw-decode/codecs.mjs";

var te = new TextEncoder(), td = new TextDecoder();
function hex(h) { return Uint8Array.from(h.match(/../g).map(function (x) { return parseInt(x, 16); })); }
function str(r) { return td.decode(r.out); }

test("LZ family: hand-built vectors decode to abc repeated", function () {
	assert.equal(str(lz4Block(hex("35616263" + "0300"))), "abcabcabcabc");
	assert.equal(str(lzf(hex("02616263" + "8002"))), "abcabcabc");
	assert.equal(str(fastlz(hex("02616263" + "8002"))), "abcabcabc");
	assert.equal(str(snappy(hex("09" + "08616263" + "0903"))), "abcabcabc");
	assert.equal(str(lzss(hex("07616263" + "eef3"))), "abcabcabc");
	assert.equal(str(lzo1x(hex("14616263" + "a800" + "110000"))), "abcabcabc");
	assert.throws(function () { lz4Block(hex("10610900")); }, /distance/);
	assert.throws(function () { lzf(hex("8002")); }, /distance/);
});

test("LZW: ABABABA in 9-bit LSB-first and MSB-first codes", function () {
	var codes = [65, 66, 256, 258];
	function pack(msb) {
		var bits = [];
		codes.forEach(function (c) { for (var i = 0; i < 9; i++) bits.push(msb ? (c >> (8 - i)) & 1 : (c >> i) & 1); });
		var out = new Uint8Array(Math.ceil(bits.length / 8));
		bits.forEach(function (b, i) { if (b) out[i >> 3] |= msb ? 0x80 >> (i & 7) : 1 << (i & 7); });
		return out;
	}
	assert.equal(str(lzw(pack(false), {})), "ABABABA");
	assert.equal(str(lzw(pack(true), { msbFirst: true })), "ABABABA");
});

test("raw LZMA: vectors from Python's lzma module", function () {
	var want = "abcabcabcabcabcabc hello hello hello world".repeat(3);
	[[3, 0, 2, "00309888aa021b28cd3095ad6903fd41f302cf0301b23b3067ffff10500000"],
		[0, 0, 0, "003099abddc0e4f20923f17761eba9bd400c2248333483447ffffc07d000"],
		[0, 1, 1, "00309889102256befb458e8a3e3a42c1a496839bfd206b193fffff98d20000"]].forEach(function (v) {
		var r = lzmaRaw(hex(v[3]), { lc: v[0], lp: v[1], pb: v[2] });
		assert.equal(str(r), want, "lc" + v[0] + " lp" + v[1] + " pb" + v[2]);
	});
});

// Reference encoder for the WNC coder (same model and layout as the paper)
function wncEncode(bytes, msbFirst) {
	var bits = 16, top = (1 << bits) - 1, q1 = Math.floor(top / 4) + 1, half = 2 * q1, q3 = 3 * q1, nsym = 257;
	var freq = new Uint32Array(nsym + 1), cum = new Uint32Array(nsym + 1);
	var c2i = new Uint16Array(256), i2c = new Uint16Array(nsym + 1);
	for (var i = 0; i < 256; i++) { c2i[i] = i + 1; i2c[i + 1] = i; }
	for (i = 0; i <= nsym; i++) { freq[i] = 1; cum[i] = nsym - i; }
	freq[0] = 0;
	var low = 0, high = top, follow = 0, out = [];
	function put(b) { out.push(b); }
	function plus(b) { put(b); while (follow > 0) { put(1 - b); follow--; } }
	function enc(s) {
		var rng = high - low + 1;
		high = low + Math.floor(rng * cum[s - 1] / cum[0]) - 1;
		low = low + Math.floor(rng * cum[s] / cum[0]);
		while (true) {
			if (high < half) plus(0);
			else if (low >= half) { plus(1); low -= half; high -= half; }
			else if (low >= q1 && high < q3) { follow++; low -= q1; high -= q1; }
			else break;
			low = 2 * low; high = 2 * high + 1;
		}
	}
	function update(s) {
		if (cum[0] === 16383) { var cm = 0; for (var j = nsym; j >= 0; j--) { freq[j] = (freq[j] + 1) >> 1; cum[j] = cm; cm += freq[j]; } }
		for (var k = s; freq[k] === freq[k - 1]; k--);
		if (k < s) { var ck = i2c[k], cs = i2c[s]; i2c[k] = cs; i2c[s] = ck; c2i[ck] = s; c2i[cs] = k; }
		freq[k]++;
		while (k > 0) { k--; cum[k]++; }
	}
	bytes.forEach(function (b) { var s = c2i[b]; enc(s); update(s); });
	enc(nsym);
	follow++; plus(low < q1 ? 0 : 1);
	var res = new Uint8Array(Math.ceil(out.length / 8) + 2);
	out.forEach(function (b, i) { if (b) res[i >> 3] |= msbFirst ? 0x80 >> (i & 7) : 1 << (i & 7); });
	return res;
}

test("WNC arithmetic decoder round-trips the reference encoder, both bit orders, and finds EOF", function () {
	var data = Array.from(te.encode("the quick brown fox jumps over the lazy dog, again and again and again"));
	[false, true].forEach(function (msb) {
		var r = wnc(wncEncode(data, msb), { msbFirst: msb });
		assert.deepEqual(Array.from(r.out), data);
		assert.equal(r.eofAt, data.length);
	});
});

// Reference Subbotin carry-less range encoder with the same adaptive model
function subbotinEncode(bytes) {
	var TOP = 1 << 24, BOT = 1 << 16, freq = new Uint32Array(256).fill(1), total = 256;
	var low = 0, range = 0xFFFFFFFF, out = [];
	bytes.forEach(function (s) {
		var c = 0; for (var i = 0; i < s; i++) c += freq[i];
		range = Math.floor(range / total);
		low = (low + c * range) >>> 0; range = (range * freq[s]) >>> 0;
		while (true) {
			if (((low ^ ((low + range) >>> 0)) >>> 0) < TOP) { /* emit */ }
			else if (range < BOT) { range = ((-low) & (BOT - 1)) >>> 0; }
			else break;
			out.push(low >>> 24); range = (range << 8) >>> 0; low = (low << 8) >>> 0;
		}
		freq[s]++; total++;
		if (total >= BOT) { total = 0; for (var j = 0; j < 256; j++) { freq[j] = (freq[j] + 1) >> 1; total += freq[j]; } }
	});
	for (var k = 0; k < 4; k++) { out.push(low >>> 24); low = (low << 8) >>> 0; }
	return Uint8Array.from(out);
}

test("Subbotin range decoder round-trips the reference encoder", function () {
	var data = Array.from(te.encode("range coding is arithmetic coding with bytes; range coding is fun"));
	var r = subbotin(subbotinEncode(data), { count: data.length });
	assert.deepEqual(Array.from(r.out), data);
});

test("universal codes: Rice, Exp-Golomb and gamma round trips", function () {
	var vals = [0, 3, -1, 7, -12, 1, 0, 25, -2];
	function encode(code, k, msb, map) {
		var bits = [];
		function put(v, n) { for (var i = 0; i < n; i++) bits.push(msb ? (v >> (n - 1 - i)) & 1 : (v >> i) & 1); }
		vals.forEach(function (v) {
			var u = map === "signmag" ? Math.abs(v) : v >= 0 ? 2 * v : -2 * v - 1;
			if (code === "rice") { for (var q = 0; q < (u >> k); q++) bits.push(0); bits.push(1); put(u & ((1 << k) - 1), k); }
			else if (code === "expgolomb") { var w = (u >> k) + 1, z = 31 - Math.clz32(w); for (var j = 0; j < z; j++) bits.push(0); bits.push(1); put(w - (1 << z), z); put(u & ((1 << k) - 1), k); }
			if (map === "signmag" && u) bits.push(v < 0 ? 1 : 0);
		});
		var out = new Uint8Array(Math.ceil(bits.length / 8));
		bits.forEach(function (b, i) { if (b) out[i >> 3] |= msb ? 0x80 >> (i & 7) : 1 << (i & 7); });
		return out;
	}
	[["rice", 2], ["expgolomb", 0], ["expgolomb", 2]].forEach(function (c) {
		[true, false].forEach(function (msb) {
			["zigzag", "signmag"].forEach(function (map) {
				var r = universal(encode(c[0], c[1], msb, map), { code: c[0], k: c[1], msbFirst: msb, map: map, count: vals.length });
				assert.deepEqual(r.values, vals, c.join(" ") + " msb " + msb + " " + map);
			});
		});
	});
});

test("Schindler range coder: shorts and model symbols round-trip, header byte optional, byte-count trailer", async function () {
	var { schindler, schindlerEncoder } = await import("../../_dev/ecw-decode/codecs.mjs");
	var e = schindlerEncoder();
	var vals = [53, 7, 7, 5, 65535, 0, 12345];
	vals.forEach(function (v) { e.short(v); });
	e.freq(3, 10, 40); e.freq(1, 0, 7); e.shift(5, 100, 12);
	var bytes = e.finish();
	var L = bytes.length;
	assert.equal((bytes[L - 3] << 16) | (bytes[L - 2] << 8) | bytes[L - 1], L, "the flush ends with the byte count");
	[{ src: bytes, opt: { header: true } }, { src: bytes.subarray(1), opt: {} }].forEach(function (c) {
		var d = schindler(c.src, c.opt);
		assert.deepEqual(vals.map(function () { return d.short(); }), vals);
		var a = d.culFreq(40); assert.ok(a >= 10 && a < 13); d.update(3, 10, 40);
		assert.equal(d.culFreq(7), 0); d.update(1, 0, 7);
		var s = d.culShift(12); assert.ok(s >= 100 && s < 105); d.updateShift(5, 100, 12);
	});
});
