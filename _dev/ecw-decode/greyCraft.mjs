// _dev/ecw-decode/greyCraft.mjs
//==========================================================
// Colour spaces and band counts the real samples lack: crafts ECW
// files with chosen coefficients (single-band greyscale, 3-band rgb,
// 4-band multiband, yuv with record-0 steps), lets the ECW SDK (QGIS
// GDAL) decode them, and compares every band it outputs with
// readRegion (RGBA shows the first three).
// Run: node _dev/ecw-decode/greyCraft.mjs
//==========================================================

import { craftEcw, sdkDecode } from "./craft.mjs";
import { openEcw } from "../../src/EcwReader.js";

var seed = 99;
function rnd(n) { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; }
function steps(bands) { return function (k) { var s = 1 + 2 * k; return { a: s, b: s + 1, c: s + 2 }; }; }

var CASES = [
	{ name: "grey-ll-sweep", width: 128, height: 128, levelCount: 1, bands: 1, colorSpace: 1,
		coeff: function (r, b, sb, x, y) { return sb === "LL" ? ((x + y * 64) % 400) - 50 : 0; } },
	{ name: "grey-random-3", width: 256, height: 192, levelCount: 3, bands: 1, colorSpace: 1, steps: true,
		coeff: function (r, b, sb, x, y) {
			if (sb === "LL") return 60 + rnd(120);
			// leave whole blocks' detail streams empty now and then
			if (((x >> 6) + (y >> 6) + r) % 3 === 0) return 0;
			return rnd(9) - 4;
		} },
	{ name: "grey-odd-4", width: 301, height: 177, levelCount: 4, bands: 1, colorSpace: 1,
		coeff: function (r, b, sb, x, y) { return sb === "LL" ? 30 + rnd(200) : rnd(5) === 0 ? rnd(41) - 20 : 0; } },
	{ name: "rgb-random-3", width: 200, height: 150, levelCount: 3, bands: 3, colorSpace: 4, steps: true,
		coeff: function (r, b, sb, x, y) { return sb === "LL" ? 40 + rnd(180) : rnd(4) === 0 ? rnd(21) - 10 : 0; } },
	{ name: "yuv-steps-3", width: 192, height: 128, levelCount: 3, bands: 3, colorSpace: 2, steps: true,
		coeff: function (r, b, sb, x, y) { return sb === "LL" ? [60 + rnd(60), rnd(21) - 10, rnd(21) - 10][b] : rnd(4) === 0 ? rnd(11) - 5 : 0; } },
	{ name: "multiband-4", width: 160, height: 160, levelCount: 2, bands: 4, colorSpace: 3,
		coeff: function (r, b, sb, x, y) { return sb === "LL" ? 20 + rnd(200) : rnd(3) === 0 ? rnd(15) - 7 : 0; } }
];

for (var c of CASES) {
	var bytes = craftEcw({ width: c.width, height: c.height, levelCount: c.levelCount, bands: c.bands, colorSpace: c.colorSpace,
		steps: c.steps ? steps(c.bands) : undefined, coeff: c.coeff });
	var sdk;
	try {
		sdk = sdkDecode(c.name, bytes).pixels;
	} catch (err) {
		console.log(c.name, "SDK could not decode:", err.message.split("\n")[0]);
		continue;
	}
	var ecw = await openEcw(new Blob([bytes]));
	var ours = await ecw.readRegion({ x: 0, y: 0, width: c.width, height: c.height });
	var shown = Math.min(3, sdk.samplesPerPixel);
	var diff = 0, max = 0, examples = [];
	for (var i = 0; i < c.width * c.height; i++) {
		var d = 0;
		for (var k = 0; k < 3; k++) {
			var want = sdk.data[i * sdk.samplesPerPixel + Math.min(k, shown - 1)];
			d = Math.max(d, Math.abs(want - ours.data[i * 4 + k]));
		}
		if (d) { diff++; if (examples.length < 4) examples.push((i % c.width) + "," + Math.floor(i / c.width)); }
		if (d > max) max = d;
	}
	console.log(c.name, c.width + "x" + c.height, ecw.info.colorSpace, "| SDK bands", sdk.samplesPerPixel, "| differing", diff, "of", c.width * c.height, "max", max, examples.length ? "e.g. " + examples.join(" ") : "");
}
