// _dev/ecw-decode/scoreDequant.mjs
// Scores dequantisation variants (via RegionDecoderScaled's ctx.dequant hook) on a GDAL reference window.
// Exports scoreWindow(dequant, refName, x, y, w, h, level?) for probes.
import fs from "node:fs";
import { openEcw } from "../../src/EcwReader.js";
import { createDecodeContext, decodeWindow } from "./RegionDecoderScaled.mjs";
import { blockEntryWindow, blockByteRange } from "../../src/format/EcwBlockIndex.js";
import { readTiff } from "../../test/helpers/readTiff.js";
import { findSample } from "../../test/helpers/samples.js";

var sample = findSample();
if (!sample) throw new Error("no samples/*.ecw with samples/ref/gdalinfo.json");
var blob = await fs.openAsBlob(sample.ecwPath);
var ecw = await openEcw(blob);
ecw._ensureIndex();
export var levels = ecw._levels;

export async function decodeYuv(dequant, level, x, y, w, h, levelRound) {
	var ctx = createDecodeContext({ header: ecw._header, levels: ecw._levels, index: ecw._index, grid: ecw._grid, fetchBlock: async function (n) {
		var e = blockEntryWindow(ecw._index, n);
		var r = blockByteRange(ecw._index, n, new Uint8Array(await blob.slice(e.start, e.end).arrayBuffer()), blob.size);
		return new Uint8Array(await blob.slice(r.start, r.end).arrayBuffer());
	} });
	ctx.dequant = dequant;
	ctx.levelRound = levelRound;
	return decodeWindow(ctx, level, x, y, x + w, y + h);
}

export function refPixels(name) { return readTiff(new Uint8Array(fs.readFileSync("samples/ref/" + name))); }

export function score(win, ref, colour) {
	var exact = 0, err = 0, max = 0, n = 0;
	for (var i = 0; i < ref.width * ref.height; i++) {
		var rgb = colour(win.bands[0][i], win.bands[1][i], win.bands[2][i]);
		for (var c = 0; c < 3; c++) { var v = Math.round(rgb[c]); v = v < 0 ? 0 : v > 255 ? 255 : v; var d = Math.abs(v - ref.data[i * 3 + c]); if (!d) exact++; err += d; if (d > max) max = d; n++; }
	}
	return (100 * exact / n).toFixed(2) + "% mean " + (err / n).toFixed(3) + " max " + max;
}

export var BT601 = function (y, u, v) { return [y + 1.402 * v + 0.5, y - 0.344136 * u - 0.714136 * v, y + 1.772 * u + 0.5]; };
