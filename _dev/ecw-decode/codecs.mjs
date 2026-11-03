// _dev/ecw-decode/codecs.mjs
//==========================================================
// Decoders for well-known general-purpose formats, written from
// their public format descriptions, used to test whether an
// unknown stream is simply one of them (codecSuite.mjs). Each
// takes a Uint8Array and options and returns
//   { out: Uint8Array, used: bytes consumed }
// or throws on input that breaks the format. Dev-only: these are
// probes, not library code, and favour clarity over speed.
//==========================================================

function fail(msg) { throw new Error(msg); }

function sink() {
	var buf = new Uint8Array(1024), n = 0;
	return {
		get length() { return n; },
		push: function (b) {
			if (n === buf.length) { var nb = new Uint8Array(buf.length * 2); nb.set(buf); buf = nb; }
			buf[n++] = b;
		},
		at: function (i) { return buf[i]; },
		done: function () { return buf.slice(0, n); }
	};
}

// Copy len bytes from dist back (overlap allowed)
function copyMatch(o, dist, len, limit) {
	if (dist <= 0 || dist > o.length) fail("match distance " + dist + " at output " + o.length);
	for (var i = 0; i < len; i++) {
		if (limit && o.length >= limit) return;
		o.push(o.at(o.length - dist));
	}
}

/** LZ4 block format (no frame). */
export function lz4Block(src, opt) {
	var limit = opt && opt.limit, o = sink(), p = 0;
	while (p < src.length) {
		var token = src[p++];
		var lit = token >> 4;
		if (lit === 15) { var b; do { if (p >= src.length) fail("eof in literal length"); b = src[p++]; lit += b; } while (b === 255); }
		if (p + lit > src.length) fail("literals past end");
		for (var i = 0; i < lit; i++) o.push(src[p++]);
		if (p === src.length) break;
		if (p + 2 > src.length) fail("eof in offset");
		var off = src[p] | (src[p + 1] << 8); p += 2;
		var ml = token & 15;
		if (ml === 15) { var c; do { if (p >= src.length) fail("eof in match length"); c = src[p++]; ml += c; } while (c === 255); }
		copyMatch(o, off, ml + 4, limit);
		if (limit && o.length >= limit) break;
	}
	return { out: o.done(), used: p };
}

/** LZF (liblzf) format. */
export function lzf(src, opt) {
	var limit = opt && opt.limit, o = sink(), p = 0;
	while (p < src.length) {
		var ctrl = src[p++];
		if (ctrl < 32) {
			var n = ctrl + 1;
			if (p + n > src.length) fail("literals past end");
			for (var i = 0; i < n; i++) o.push(src[p++]);
		} else {
			var len = ctrl >> 5;
			if (len === 7) { if (p >= src.length) fail("eof"); len += src[p++]; }
			if (p >= src.length) fail("eof in offset");
			var dist = ((ctrl & 0x1f) << 8) + src[p++] + 1;
			copyMatch(o, dist, len + 2, limit);
		}
		if (limit && o.length >= limit) break;
	}
	return { out: o.done(), used: p };
}

/** FastLZ level 1 and level 2 (the level is in the top 3 bits of the first byte). */
export function fastlz(src, opt) {
	var limit = opt && opt.limit, o = sink(), p = 0;
	var level = (src[0] >> 5) + 1;
	if (level !== 1 && level !== 2) fail("fastlz level " + level);
	var ctrl = src[p++] & 31, first = true;
	while (true) {
		if (!first) { if (p >= src.length) break; ctrl = src[p++]; }
		first = false;
		if (ctrl < 32) {
			var n = ctrl + 1;
			if (p + n > src.length) fail("literals past end");
			for (var i = 0; i < n; i++) o.push(src[p++]);
		} else {
			var len = (ctrl >> 5) - 1;
			var ofs = (ctrl & 31) << 8;
			if (level === 1) {
				if (len === 6) { if (p >= src.length) fail("eof"); len += src[p++]; }
				if (p >= src.length) fail("eof");
				copyMatch(o, ofs + src[p++] + 1, len + 3, limit);
			} else {
				if (len === 6) { var c; do { if (p >= src.length) fail("eof"); c = src[p++]; len += c; } while (c === 255); }
				if (p >= src.length) fail("eof");
				var code = src[p++];
				var dist = ofs + code;
				if (code === 255 && ofs === (31 << 8)) {
					if (p + 2 > src.length) fail("eof");
					dist = (src[p] << 8) + src[p + 1] + 8191; p += 2;
				}
				copyMatch(o, dist + 1, len + 3, limit);
			}
		}
		if (limit && o.length >= limit) break;
	}
	return { out: o.done(), used: p };
}

/** Snappy raw block (varint length prefix). */
export function snappy(src) {
	var p = 0, total = 0, shift = 0, b;
	do { if (p >= src.length || shift > 28) fail("bad length varint"); b = src[p++]; total |= (b & 127) << shift; shift += 7; } while (b & 128);
	var o = sink();
	while (p < src.length && o.length < total) {
		var tag = src[p++], type = tag & 3;
		if (type === 0) {
			var len = tag >> 2;
			if (len >= 60) { var nb = len - 59; len = 0; for (var i = 0; i < nb; i++) len |= src[p++] << (8 * i); }
			len += 1;
			if (p + len > src.length) fail("literal past end");
			for (var k = 0; k < len; k++) o.push(src[p++]);
		} else if (type === 1) {
			var l1 = ((tag >> 2) & 7) + 4, d1 = ((tag >> 5) << 8) | src[p++];
			copyMatch(o, d1, l1);
		} else if (type === 2) {
			copyMatch(o, src[p] | (src[p + 1] << 8), (tag >> 2) + 1); p += 2;
		} else {
			copyMatch(o, src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24), (tag >> 2) + 1); p += 4;
		}
	}
	if (o.length !== total) fail("decoded " + o.length + " of " + total);
	return { out: o.done(), used: p };
}

/**
 * LZSS as in Okumura's LZSS.C: N 4096, F 18, threshold 2, ring
 * buffer filled with `fill` from position N - F, flag bits LSB first.
 * literalBit: the flag value meaning "literal" (1 in LZSS.C).
 */
export function lzss(src, opt) {
	var N = 4096, F = 18, T = 2, limit = opt && opt.limit;
	var literalBit = opt && opt.literalBit !== undefined ? opt.literalBit : 1;
	var ring = new Uint8Array(N).fill(opt && opt.fill !== undefined ? opt.fill : 0x20);
	var r = N - F, flags = 0, o = sink(), p = 0;
	while (true) {
		flags >>= 1;
		if ((flags & 256) === 0) { if (p >= src.length) break; flags = src[p++] | 0xff00; }
		if ((flags & 1) === literalBit) {
			if (p >= src.length) break;
			var c = src[p++]; o.push(c); ring[r++] = c; r &= N - 1;
		} else {
			if (p + 2 > src.length) break;
			var i = src[p++], j = src[p++];
			i |= (j & 0xf0) << 4; j = (j & 0x0f) + T;
			for (var k = 0; k <= j; k++) { var cc = ring[(i + k) & (N - 1)]; o.push(cc); ring[r++] = cc; r &= N - 1; }
		}
		if (limit && o.length >= limit) break;
	}
	return { out: o.done(), used: p };
}

/**
 * LZW with variable code width. opt: { msbFirst, maxBits (12 or 16),
 * clearCode (true: 256 clear, 257 end as in GIF/TIFF; false: no
 * reserved codes as in plain LZW), earlyChange (TIFF style) }.
 */
export function lzw(src, opt) {
	var o = opt || {}, msb = !!o.msbFirst, maxBits = o.maxBits || 12, reserved = o.clearCode ? 258 : 256;
	var limit = o.limit, early = o.earlyChange ? 1 : 0;
	var bitPos = 0, totalBits = src.length * 8;
	function read(w) {
		if (bitPos + w > totalBits) return -1;
		var v = 0;
		for (var i = 0; i < w; i++) {
			var byte = src[(bitPos + i) >> 3], bit = (bitPos + i) & 7;
			var b = msb ? (byte >> (7 - bit)) & 1 : (byte >> bit) & 1;
			v = msb ? (v << 1) | b : v | (b << i);
		}
		bitPos += w;
		return v;
	}
	var dict = [], width = 9, next = reserved, prev = null, out = [];
	function reset() { dict = []; for (var i = 0; i < 256; i++) dict[i] = [i]; width = 9; next = reserved; prev = null; }
	reset();
	while (true) {
		var code = read(width);
		if (code < 0) break;
		if (o.clearCode && code === 256) { reset(); continue; }
		if (o.clearCode && code === 257) break;
		var entry;
		if (code < next && dict[code]) entry = dict[code];
		else if (code === next && prev) entry = prev.concat([prev[0]]);
		else fail("code " + code + " with next " + next);
		for (var k = 0; k < entry.length; k++) out.push(entry[k]);
		if (prev && next < (1 << maxBits)) { dict[next++] = prev.concat([entry[0]]); }
		if (next + early >= (1 << width) && width < maxBits) width++;
		prev = entry;
		if (limit && out.length >= limit) break;
	}
	return { out: Uint8Array.from(out), used: Math.ceil(bitPos / 8) };
}

/** LZO1X (lzo1x_decompress) format. */
export function lzo1x(src, opt) {
	var limit = opt && opt.limit, o = sink(), p = 0, t, state = 0;
	function need(n) { if (p + n > src.length) fail("eof"); }
	function lit(n) { need(n); for (var i = 0; i < n; i++) o.push(src[p++]); }
	function longLen(base) { var x = 0; need(1); while (src[p] === 0) { x += 255; p++; need(1); } return x + base + src[p++]; }
	need(1);
	if (src[p] > 17) { t = src[p++] - 17; lit(t); state = t < 4 ? t : 4; }
	while (true) {
		need(1);
		t = src[p++];
		var len, dist;
		if (t < 16) {
			if (state === 0) {
				if (t === 0) t = longLen(15);
				lit(t + 3); state = 4; continue;
			} else if (state < 4) {
				need(1); dist = (t >> 2) + (src[p++] << 2) + 1; len = 2;
			} else {
				need(1); dist = (t >> 2) + (src[p++] << 2) + 2049; len = 3;
			}
		} else if (t >= 64) {
			need(1); dist = ((t >> 2) & 7) + (src[p++] << 3) + 1; len = (t >> 5) + 1;
		} else if (t >= 32) {
			len = t & 31; if (len === 0) len = longLen(31); len += 2;
			need(2); dist = (src[p] >> 2) + (src[p + 1] << 6) + 1; t = src[p]; p += 2;
		} else {
			len = t & 7; if (len === 0) len = longLen(7); len += 2;
			dist = (t & 8) << 11;
			need(2); dist += (src[p] >> 2) + (src[p + 1] << 6); var t2 = src[p]; p += 2;
			if (dist === 0) { if (len !== 3) fail("bad end"); return { out: o.done(), used: p }; }
			dist += 16384; t = t2;
		}
		copyMatch(o, dist, len, limit);
		if (limit && o.length >= limit) return { out: o.done(), used: p };
		var s = t & 3;
		lit(s);
		state = s;
	}
}

/**
 * Raw LZMA (no header): the range coder's first byte is always 0.
 * opt: { lc, lp, pb, dictSize, limit (stop after this many bytes) }.
 */
export function lzmaRaw(src, opt) {
	var lc = opt.lc, lp = opt.lp, pb = opt.pb, limit = opt.limit;
	var pos = 0;
	if (src[pos++] !== 0) fail("first range coder byte is not 0");
	var range = 0xFFFFFFFF, code = 0;
	for (var i = 0; i < 4; i++) code = ((code << 8) | src[pos++]) >>> 0;
	if (code === range) fail("bad init");
	function norm() { if (range < 0x1000000) { if (pos >= src.length) fail("eof"); range = (range << 8) >>> 0; code = ((code << 8) | src[pos++]) >>> 0; } }
	function bit(p, i) {
		var bound = ((range >>> 11) * p[i]) >>> 0, b;
		if (code < bound) { range = bound; p[i] += (2048 - p[i]) >> 5; b = 0; }
		else { range = (range - bound) >>> 0; code = (code - bound) >>> 0; p[i] -= p[i] >> 5; b = 1; }
		norm(); return b;
	}
	function direct(n) { var r = 0; for (var i = 0; i < n; i++) { range >>>= 1; var b = code >= range ? 1 : 0; if (b) code = (code - range) >>> 0; r = (r << 1) | b; norm(); } return r >>> 0; }
	function P(n) { return new Uint16Array(n).fill(1024); }
	function tree(p, base, n) { var m = 1; for (var i = 0; i < n; i++) m = (m << 1) | bit(p, base + m); return m - (1 << n); }
	function rtree(p, base, n) { var m = 1, s = 0; for (var i = 0; i < n; i++) { var b = bit(p, base + m); m = (m << 1) | b; s |= b << i; } return s; }
	var lit = P(0x300 << (lc + lp)), isMatch = P(192), isRep = P(12), isRepG0 = P(12), isRepG1 = P(12), isRepG2 = P(12), isRep0Long = P(192);
	var posSlot = P(256), posDec = P(115), align = P(16);
	function lenCoder() { return { c: P(2), low: P(16 * 8), mid: P(16 * 8), high: P(256) }; }
	var lenC = lenCoder(), repLenC = lenCoder();
	function decLen(L, ps) { if (!bit(L.c, 0)) return tree(L.low, ps * 8, 3); if (!bit(L.c, 1)) return 8 + tree(L.mid, ps * 8, 3); return 16 + tree(L.high, 0, 8); }
	var o = sink(), state = 0, r0 = 0, r1 = 0, r2 = 0, r3 = 0;
	var pbMask = (1 << pb) - 1, lpMask = (1 << lp) - 1;
	while (true) {
		if (limit && o.length >= limit) break;
		var ps = o.length & pbMask;
		if (!bit(isMatch, (state << 4) + ps)) {
			var prev = o.length ? o.at(o.length - 1) : 0;
			var base = 0x300 * (((o.length & lpMask) << lc) + (prev >> (8 - lc)));
			var sym = 1;
			if (state >= 7) {
				var mb = o.at(o.length - r0 - 1);
				do { var mbit = (mb >> 7) & 1; mb <<= 1; var b = bit(lit, base + ((1 + mbit) << 8) + sym); sym = (sym << 1) | b; if (mbit !== b) break; } while (sym < 0x100);
			}
			while (sym < 0x100) sym = (sym << 1) | bit(lit, base + sym);
			o.push(sym & 0xff);
			state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
			continue;
		}
		var len;
		if (bit(isRep, state)) {
			if (!o.length) fail("rep at start");
			if (!bit(isRepG0, state)) {
				if (!bit(isRep0Long, (state << 4) + ps)) { state = state < 7 ? 9 : 11; o.push(o.at(o.length - r0 - 1)); continue; }
			} else {
				var d;
				if (!bit(isRepG1, state)) { d = r1; } else { if (!bit(isRepG2, state)) { d = r2; } else { d = r3; r3 = r2; } r2 = r1; }
				r1 = r0; r0 = d;
			}
			len = decLen(repLenC, ps); state = state < 7 ? 8 : 11;
		} else {
			r3 = r2; r2 = r1; r1 = r0;
			len = decLen(lenC, ps); state = state < 7 ? 7 : 10;
			var lenState = len < 3 ? len : 3;
			var slot = tree(posSlot, lenState << 6, 6);
			if (slot < 4) r0 = slot;
			else {
				var nd = (slot >> 1) - 1; r0 = ((2 | (slot & 1)) << nd) >>> 0;
				if (slot < 14) r0 += rtree(posDec, r0 - slot, nd);
				else { r0 += direct(nd - 4) << 4; r0 += rtree(align, 0, 4); }
				if (r0 === 0xFFFFFFFF) break;
			}
		}
		len += 2;
		if (r0 >= o.length) fail("distance " + (r0 + 1) + " past output " + o.length);
		for (var k = 0; k < len; k++) { o.push(o.at(o.length - r0 - 1)); if (limit && o.length >= limit) break; }
	}
	return { out: o.done(), used: pos };
}

/**
 * Witten-Neal-Cleary (CACM 1987) adaptive order-0 arithmetic decoder,
 * 16-bit code values, 256 chars + EOF, Max_frequency 16383, increment 1.
 * opt: { msbFirst (bit packing within bytes; the paper's code is LSB first),
 * count: symbols to decode (stops early at EOF) }.
 */
export function wnc(src, opt) {
	var bits = 16, top = (1 << bits) - 1, q1 = Math.floor(top / 4) + 1, half = 2 * q1, q3 = 3 * q1;
	var nsym = 257, maxFreq = 16383, inc = (opt && opt.inc) || 1;
	var freq = new Uint32Array(nsym + 1), cum = new Uint32Array(nsym + 1);
	// index 1..257; cum[i] = sum of freq of indexes > i (paper's layout)
	var charToIndex = new Uint16Array(256), indexToChar = new Uint16Array(nsym + 1);
	for (var i = 0; i < 256; i++) { charToIndex[i] = i + 1; indexToChar[i + 1] = i; }
	for (i = 0; i <= nsym; i++) { freq[i] = 1; cum[i] = nsym - i; }
	freq[0] = 0;
	var msb = opt && opt.msbFirst, bp = 0, garbage = 0;
	function inBit() {
		var byte = bp >> 3;
		if (byte >= src.length) { garbage++; bp++; return 0; }
		var b = msb ? (src[byte] >> (7 - (bp & 7))) & 1 : (src[byte] >> (bp & 7)) & 1;
		bp++; return b;
	}
	var value = 0, low = 0, high = top;
	for (i = 0; i < bits; i++) value = 2 * value + inBit();
	var out = [], count = opt && opt.count, sawEof = -1;
	while (!count || out.length < count) {
		var rng = high - low + 1;
		var c = Math.floor(((value - low + 1) * cum[0] - 1) / rng);
		var s = 1;
		while (cum[s] > c) s++;
		high = low + Math.floor(rng * cum[s - 1] / cum[0]) - 1;
		low = low + Math.floor(rng * cum[s] / cum[0]);
		while (true) {
			if (high < half) { /* nothing */ }
			else if (low >= half) { value -= half; low -= half; high -= half; }
			else if (low >= q1 && high < q3) { value -= q1; low -= q1; high -= q1; }
			else break;
			low = 2 * low; high = 2 * high + 1; value = 2 * value + inBit();
		}
		if (s === nsym) { sawEof = out.length; break; }
		out.push(indexToChar[s]);
		// update model
		if (cum[0] === maxFreq) { var cm = 0; for (var j = nsym; j >= 0; j--) { freq[j] = (freq[j] + 1) >> 1; cum[j] = cm; cm += freq[j]; } }
		for (var k = s; freq[k] === freq[k - 1]; k--);
		if (k < s) { var ck = indexToChar[k], cs = indexToChar[s]; indexToChar[k] = cs; indexToChar[s] = ck; charToIndex[ck] = s; charToIndex[cs] = k; }
		freq[k] += inc;
		while (k > 0) { k--; cum[k] += inc; }
	}
	return { out: Uint8Array.from(out), used: Math.ceil((bp - garbage) / 8), eofAt: sawEof, garbageBits: garbage };
}

/**
 * Carry-less range coder (Subbotin) with an adaptive order-0 byte model:
 * all frequencies start at 1, +inc per symbol, halved when the total reaches 1 << 16.
 */
export function subbotin(src, opt) {
	var TOP = 1 << 24, BOT = 1 << 16, inc = (opt && opt.inc) || 1, count = opt && opt.count;
	var freq = new Uint32Array(256).fill(1), total = 256;
	var low = 0, range = 0xFFFFFFFF, code = 0, p = 0;
	function next() { return p < src.length ? src[p++] : (p++, 0); }
	for (var i = 0; i < 4; i++) code = ((code << 8) | next()) >>> 0;
	var out = [];
	while (out.length < count) {
		range = Math.floor(range / total);
		var v = Math.floor(((code - low) >>> 0) / range);
		if (v >= total) fail("value past total");
		var s = 0, c = 0;
		while (c + freq[s] <= v) { c += freq[s]; s++; }
		low = (low + c * range) >>> 0; range = (range * freq[s]) >>> 0;
		while (true) {
			if (((low ^ ((low + range) >>> 0)) >>> 0) < TOP) { /* top byte settled */ }
			else if (range < BOT) { range = ((-low) & (BOT - 1)) >>> 0; }
			else break;
			code = ((code << 8) | next()) >>> 0; range = (range << 8) >>> 0; low = (low << 8) >>> 0;
		}
		out.push(s);
		freq[s] += inc; total += inc;
		if (total >= BOT) { total = 0; for (var j = 0; j < 256; j++) { freq[j] = (freq[j] + 1) >> 1; total += freq[j]; } }
	}
	return { out: Uint8Array.from(out), used: Math.min(p, src.length), over: Math.max(0, p - src.length) };
}

/**
 * Universal integer codes, count values. opt: { code: "rice"|"expgolomb"|"gamma",
 * k, msbFirst, map: "zigzag"|"signmag" }. Returns values and bits used.
 */
export function universal(src, opt) {
	var msb = !!opt.msbFirst, bp = 0, total = src.length * 8;
	function bit() { if (bp >= total) fail("eof"); var by = src[bp >> 3], b = msb ? (by >> (7 - (bp & 7))) & 1 : (by >> (bp & 7)) & 1; bp++; return b; }
	function bitsN(n) { var v = 0; for (var i = 0; i < n; i++) v = msb ? v * 2 + bit() : v + bit() * Math.pow(2, i); return v; }
	var vals = [];
	for (var n = 0; n < opt.count; n++) {
		var u;
		if (opt.code === "rice") { var q = 0; while (bit() === (opt.ones ? 1 : 0)) { if (++q > 64) fail("long unary"); } u = q * Math.pow(2, opt.k) + bitsN(opt.k); }
		else if (opt.code === "expgolomb") { var z = 0; while (bit() === 0) { if (++z > 30) fail("long prefix"); } var rest = bitsN(z); u = (Math.pow(2, z) - 1 + rest) * Math.pow(2, opt.k) + bitsN(opt.k); }
		else { var zz = 0; while (bit() === 0) { if (++zz > 30) fail("long prefix"); } u = Math.pow(2, zz) + bitsN(zz) - 1; }
		var v;
		if (opt.map === "signmag") { if (u === 0) v = 0; else { var sgn = bit(); v = sgn ? -u : u; } }
		else v = u & 1 ? -((u + 1) / 2) : u / 2;
		vals.push(v);
	}
	return { values: vals, usedBits: bp };
}

/**
 * Schindler's range coder (1998): 31-bit low with a carry byte
 * buffer, output byte = low >> 23, 7 extra bits, normalised while
 * range <= 2^23. The encoder's flush ends with the byte count as three
 * big-endian bytes. Returns a stateful decoder; the model sits on top:
 *   culFreq(tot) / culShift(bits) -> cumulative count, then
 *   update(symFreq, lowCum, tot) / updateShift(symFreq, lowCum, bits).
 * opt.header: the stream starts with a header byte before the first
 * coder byte (Schindler's start_encoding(c)); default false.
 */
export function schindler(src, opt) {
	var EXTRA = 7, BOTTOM = 1 << 23, p = 0, past = 0;
	function inbyte() { if (p < src.length) return src[p++]; past++; p++; return 0; }
	if (opt && opt.header) inbyte();
	var buffer = inbyte();
	var low = buffer >>> (8 - EXTRA), range = 1 << EXTRA, help = 0;
	function normalize() {
		while (range <= BOTTOM) {
			low = ((low << 8) | ((buffer << EXTRA) & 0xff)) >>> 0;
			buffer = inbyte();
			low = (low | (buffer >>> (8 - EXTRA))) >>> 0;
			range = (range * 256) >>> 0;
		}
	}
	return {
		get pos() { return p; },
		get past() { return past; },
		culFreq: function (tot) { normalize(); help = Math.floor(range / tot); var t = Math.floor(low / help); return t >= tot ? tot - 1 : t; },
		culShift: function (bits) { normalize(); help = range >>> bits; var t = Math.floor(low / help); return t >>> bits ? (1 << bits) - 1 : t; },
		update: function (sf, lt, tot) { var t = help * lt; low = (low - t) >>> 0; if (lt + sf < tot) range = (help * sf) >>> 0; else range = (range - t) >>> 0; },
		updateShift: function (sf, lt, bits) { this.update(sf, lt, 1 << bits); },
		short: function () { var v = this.culShift(16); this.updateShift(1, v, 16); return v; },
		byte: function () { var v = this.culShift(8); this.updateShift(1, v, 8); return v; }
	};
}

/** Schindler range encoder (reference for tests and forward checks). */
export function schindlerEncoder(opt) {
	var TOP = 0x80000000, SHIFT = 23, BOTTOM = 1 << 23, out = [];
	var low = 0, range = TOP, buffer = (opt && opt.header) || 0, help = 0, bytecount = 0, wroteHeader = !!(opt && opt.header !== undefined);
	function outbyte(b) { out.push(b & 0xff); }
	function normalize() {
		while (range <= BOTTOM) {
			if (low < (0xff * BOTTOM)) { outbyte(buffer); for (; help; help--) outbyte(0xff); buffer = (low >>> SHIFT) & 0xff; }
			else if (low >= TOP) { outbyte(buffer + 1); for (; help; help--) outbyte(0); buffer = (low >>> SHIFT) & 0xff; }
			else help++;
			range = (range * 256) >>> 0; low = ((low * 256) % TOP) >>> 0; bytecount++;
		}
	}
	return {
		freq: function (sf, lt, tot) { normalize(); var r = Math.floor(range / tot), t = r * lt; low = low + t; if (lt + sf < tot) range = r * sf; else range = range - t; },
		shift: function (sf, lt, bits) { this.freq(sf, lt, 1 << bits); },
		short: function (v) { this.shift(1, v, 16); },
		finish: function () {
			normalize(); bytecount += 5;
			var t = (low & (BOTTOM - 1)) < ((bytecount & 0xffffff) >>> 1) ? low >>> SHIFT : (low >>> SHIFT) + 1;
			if (t > 0xff) { outbyte(buffer + 1); for (; help; help--) outbyte(0); }
			else { outbyte(buffer); for (; help; help--) outbyte(0xff); }
			outbyte(t & 0xff); outbyte((bytecount >> 16) & 0xff); outbyte((bytecount >> 8) & 0xff); outbyte(bytecount & 0xff);
			var res = Uint8Array.from(out);
			return wroteHeader ? res : res;
		}
	};
}
