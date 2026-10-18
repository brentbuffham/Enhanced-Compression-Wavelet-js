// _dev/ecw-decode/cornerBisect.mjs
//==========================================================
// Re-crafts the private sample's first records as a small ECW (the SDK
// decodes it identically to the real file's overview) and lists where
// our decode differs from the SDK's. Optional masks zero coefficients
// to bisect which configuration triggers the difference.
// Run: node --max-old-space-size=4096 _dev/ecw-decode/cornerBisect.mjs [records]
//==========================================================

import { craftEcw, sdkDecode } from "./craft.mjs";
import { openFile, levelPlanes } from "./levelPlanes.mjs";
import { openEcw } from "../../src/EcwReader.js";
import { findSample } from "../../test/helpers/samples.js";

export function loadPlanes(records) {
	var f = openFile(findSample().ecwPath);
	var P = [];
	for (var k = 0; k < records; k++) P.push(levelPlanes(f, k));
	return P;
}

/** Craft, decode with SDK and ours; return differing pixels [{x, y, sdk:[r,g,b], ours:[r,g,b]}]. */
export async function compare(name, o) {
	var bytes = craftEcw(o);
	var sdk = sdkDecode(name, bytes).pixels;
	var ours = await (await openEcw(new Blob([bytes]))).readRegion({ x: 0, y: 0, width: sdk.width, height: sdk.height });
	var diffs = [];
	for (var y = 0; y < sdk.height; y++) for (var x = 0; x < sdk.width; x++) {
		var i = y * sdk.width + x, d = false;
		for (var k = 0; k < 3; k++) if (sdk.data[i * 3 + k] !== ours.data[i * 4 + k]) d = true;
		if (d) diffs.push({ x: x, y: y, sdk: Array.from(sdk.data.subarray(i * 3, i * 3 + 3)), ours: Array.from(ours.data.subarray(i * 4, i * 4 + 3)) });
	}
	return diffs;
}

if (import.meta.url === "file:///" + process.argv[1].replace(/\\/g, "/")) {
	var R = Number(process.argv[2] || 4);
	var P = loadPlanes(R);
	var last = P[R - 1];
	var W = last.width * 2, H = last.height * 2;
	var diffs = await compare("bisect-" + R, { width: W, height: H, levelCount: R, coeff: function (r, b, sb, x, y) { return P[r].planes[b][sb][y * P[r].width + x]; } });
	console.log(diffs.length + " differing pixels");
	diffs.forEach(function (d) { console.log(d.x, d.y, "sdk", d.sdk.join(","), "ours", d.ours.join(",")); });
}
