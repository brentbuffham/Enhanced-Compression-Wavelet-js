// _dev/ecw-decode/codecSuite.mjs
//==========================================================
// Is an unknown stream mode just a well-known codec? Runs every
// stream of one mode (from modeStreams.mjs --out) through a suite of
// general-purpose decoders (codecs.mjs, plus Node's zlib, Brotli and
// zstd), over several byte windows, and scores each variant by how
// many streams decode cleanly, use the whole window, and give an
// output whose size fits the block (count = pw * ph values of 1, 2
// or 4 bytes). A real match fits every stream.
// Usage: node _dev/ecw-decode/codecSuite.mjs <streams.json> [--quick]
//==========================================================

import fs from "node:fs";
import zlib from "node:zlib";
import { lz4Block, lzf, fastlz, snappy, lzss, lzw, lzo1x, lzmaRaw, wnc, subbotin, universal } from "./codecs.mjs";

var J = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
var quick = process.argv.indexOf("--quick") >= 0;
var streams = [];
J.blocks.forEach(function (b) {
	b.streams.forEach(function (s) {
		if (s.mode === J.mode) streams.push({ bytes: Uint8Array.from(Buffer.from(s.hex, "hex")), count: b.pw * b.ph, mode: s.mode });
	});
});
if (quick) streams = streams.slice(0, 30);

// Byte windows of a payload: the codec might include or exclude the
// leading byte, the trailer, or even the mode byte
var WINDOWS = {
	"payload": function (x) { return x.bytes; },
	"+modebyte": function (x) { var o = new Uint8Array(x.bytes.length + 1); o[0] = x.mode; o.set(x.bytes, 1); return o; },
	"skip1": function (x) { return x.bytes.subarray(1); },
	"-trailer": function (x) { return x.bytes.subarray(0, x.bytes.length - 3); },
	"skip1-trailer": function (x) { return x.bytes.subarray(1, x.bytes.length - 3); }
};

function sizeFits(n, count) { return n === count || n === 2 * count || n === 4 * count; }

var results = [];
function run(name, fn) {
	Object.keys(WINDOWS).forEach(function (w) {
		var clean = 0, whole = 0, fits = 0, match = 0, sizes = new Map(), errs = new Map();
		streams.forEach(function (x) {
			var src = WINDOWS[w](x);
			try {
				var r = fn(src, x.count);
				clean++;
				var isWhole = r.used === undefined || Math.abs(r.used - src.length) <= 1;
				var isFit = r.fits !== undefined ? !!r.fits : !!(r.out && sizeFits(r.out.length, x.count));
				if (isWhole) whole++;
				if (isFit) fits++;
				// a match needs both on the same stream: decoders told to stop at a count always "fit"
				if (isWhole && isFit) match++;
				var key = r.out ? (r.out.length / x.count).toFixed(2) : "-";
				sizes.set(key, (sizes.get(key) || 0) + 1);
			} catch (e) {
				var m = String(e && e.message || e).replace(/[0-9]+/g, "#").slice(0, 40);
				errs.set(m, (errs.get(m) || 0) + 1);
			}
		});
		var topErr = Array.from(errs.entries()).sort(function (a, b) { return b[1] - a[1]; })[0];
		var topSize = Array.from(sizes.entries()).sort(function (a, b) { return b[1] - a[1]; })[0];
		results.push({ name: name, window: w, clean: clean, whole: whole, fits: fits, match: match,
			note: topErr ? topErr[1] + "x " + topErr[0] : "", size: topSize ? "out/count " + topSize[0] + " x" + topSize[1] : "" });
	});
}

// Step 1) Node's built-in formats
run("deflate-raw", function (s) { return { out: zlib.inflateRawSync(s) }; });
run("zlib", function (s) { return { out: zlib.inflateSync(s) }; });
run("gzip", function (s) { return { out: zlib.gunzipSync(s) }; });
run("brotli", function (s) { return { out: zlib.brotliDecompressSync(s) }; });
if (zlib.zstdDecompressSync) run("zstd", function (s) { return { out: zlib.zstdDecompressSync(s) }; });

// Step 2) LZ family
run("lz4-block", function (s, n) { return lz4Block(s, { limit: 4 * n + 1 }); });
run("lzf", function (s, n) { return lzf(s, { limit: 4 * n + 1 }); });
run("fastlz", function (s, n) { return fastlz(s, { limit: 4 * n + 1 }); });
run("snappy", function (s) { return snappy(s); });
[1, 0].forEach(function (lb) { [0x20, 0].forEach(function (fill) {
	run("lzss lit=" + lb + " fill=" + fill.toString(16), function (s, n) { return lzss(s, { literalBit: lb, fill: fill, limit: 4 * n + 1 }); });
}); });
[false, true].forEach(function (msb) { [12, 16].forEach(function (mb) { [false, true].forEach(function (cc) { [false, true].forEach(function (early) {
	run("lzw " + (msb ? "msb" : "lsb") + " max" + mb + (cc ? " clear" : "") + (early ? " early" : ""), function (s, n) { return lzw(s, { msbFirst: msb, maxBits: mb, clearCode: cc, earlyChange: early, limit: 4 * n + 1 }); });
}); }); }); });
run("lzo1x", function (s, n) { return lzo1x(s, { limit: 4 * n + 1 }); });
for (var lc = 0; lc <= 4; lc++) for (var lp = 0; lp <= 2; lp++) for (var pb = 0; pb <= 2; pb++) {
	(function (lc, lp, pb) {
		run("lzma lc" + lc + " lp" + lp + " pb" + pb, function (s, n) {
			var r = lzmaRaw(s, { lc: lc, lp: lp, pb: pb, limit: 4 * n });
			// with a limit, only the reached size says anything
			return { out: r.out, used: r.used };
		});
	})(lc, lp, pb);
}

// Step 3) Entropy coders over bytes: decode count, 2*count or 4*count symbols
[false, true].forEach(function (msb) { [1, 32].forEach(function (inc) {
	run("wnc arith " + (msb ? "msb" : "lsb") + " inc" + inc, function (s, n) {
		// the 257-symbol model has an EOF symbol: a real stream ends with it at a fitting size
		var r = wnc(s, { msbFirst: msb, inc: inc, count: 4 * n + 1 });
		if (r.eofAt < 0) throw new Error("no EOF");
		return { out: r.out, used: r.used };
	});
}); });
[1, 32].forEach(function (inc) { [1, 2, 4].forEach(function (k) {
	run("subbotin inc" + inc + " x" + k, function (s, n) {
		var r = subbotin(s, { inc: inc, count: k * n });
		if (r.over > 4) throw new Error("ran past the input");
		return { out: r.out, used: r.used };
	});
}); });

// Step 4) Universal integer codes, one value per coefficient
var codes = [];
for (var k = 0; k <= 8; k++) codes.push({ code: "rice", k: k, ones: false }, { code: "rice", k: k, ones: true });
for (k = 0; k <= 5; k++) codes.push({ code: "expgolomb", k: k });
codes.push({ code: "gamma", k: 0 });
codes.forEach(function (c) { [false, true].forEach(function (msb) { ["zigzag", "signmag"].forEach(function (map) {
	run(c.code + " k" + c.k + (c.ones ? " ones" : "") + " " + (msb ? "msb" : "lsb") + " " + map, function (s, n) {
		var r = universal(s, { code: c.code, k: c.k, ones: c.ones, msbFirst: msb, map: map, count: n });
		var mean = r.values.reduce(function (a, v) { return a + Math.abs(v); }, 0) / n;
		if (mean > 200) throw new Error("magnitudes too large");
		return { used: Math.ceil(r.usedBits / 8), fits: Math.abs(Math.ceil(r.usedBits / 8) - s.length) <= 1 };
	});
}); }); });

// Report: best variants first
results.sort(function (a, b) { return b.match - a.match || (b.fits + b.whole) - (a.fits + a.whole) || b.clean - a.clean; });
console.log(streams.length + " streams, " + results.length + " codec x window variants. Columns: decoded cleanly / used whole window / output size fits the block");
console.log("variant".padEnd(36) + "window".padEnd(15) + "clean whole  fits match  notes");
results.slice(0, 40).forEach(function (r) {
	console.log(r.name.padEnd(36) + r.window.padEnd(15) + String(r.clean).padStart(5) + String(r.whole).padStart(6) + String(r.fits).padStart(6) + String(r.match).padStart(6) + "  " + (r.size || "") + (r.note ? "  err: " + r.note : ""));
});
var perfect = results.filter(function (r) { return r.match === streams.length; });
console.log("\nvariants that fit every stream: " + (perfect.length ? perfect.map(function (r) { return r.name + " / " + r.window; }).join(", ") : "none"));
var families = new Map();
results.forEach(function (r) { var f = r.name.split(" ")[0]; var cur = families.get(f) || 0; families.set(f, Math.max(cur, r.match)); });
console.log("best match per family (streams that decode whole AND fit): " + Array.from(families.entries()).map(function (e) { return e[0] + " " + e[1]; }).join(", "));
