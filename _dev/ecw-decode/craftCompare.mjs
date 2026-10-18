// _dev/ecw-decode/craftCompare.mjs
// Decodes a crafted ECW with the probe decoder (hooks: levelRound) and compares with the SDK's decode.
import { createDecodeContext, decodeWindow } from "./RegionDecoderScaled.mjs";
import { parseHeader } from "../../src/format/EcwHeader.js";
import { parseLevels } from "../../src/format/EcwLevels.js";
import { parseBlockIndex, blockGrid, blockEntryWindow, blockByteRange } from "../../src/format/EcwBlockIndex.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { yuvToRgba } from "../../src/codec/colour.js";

export async function probeDecode(bytes, hooks) {
	var src = new MemorySource(bytes), h = parseHeader(src), lv = parseLevels(src, h), idx = parseBlockIndex(src, h);
	var ctx = createDecodeContext({ header: h, levels: lv, index: idx, grid: blockGrid(h, lv), fetchBlock: async function (n) {
		var w = blockEntryWindow(idx, n), r = blockByteRange(idx, n, bytes.subarray(w.start, w.end), bytes.length);
		return bytes.subarray(r.start, r.end);
	} });
	ctx.dequant = function (r, b, sb, q, l) { return q * (b === 0 ? l.a : b === 1 ? l.b : l.c); };
	Object.assign(ctx, hooks || {});
	var win = await decodeWindow(ctx, h.levelCount, 0, 0, h.width, h.height);
	var rgba = new Uint8ClampedArray(h.width * h.height * 4);
	yuvToRgba(win.bands[0], win.bands[1], win.bands[2], rgba);
	return { rgba: rgba, width: h.width, height: h.height, win: win };
}

export function compareRgb(ours, sdk) {
	var ex = 0, max = 0, n = 0;
	for (var i = 0; i < ours.width * ours.height; i++) for (var c = 0; c < 3; c++) { var d = Math.abs(ours.rgba[i * 4 + c] - sdk.data[i * 3 + c]); if (!d) ex++; if (d > max) max = d; n++; }
	return (100 * ex / n).toFixed(2) + "% max " + max;
}
