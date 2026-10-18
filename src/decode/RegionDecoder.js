// src/decode/RegionDecoder.js
//==========================================================
// Windowed reconstruction of any image level (FINDINGS.md
// "coefficient layout"). Image level 0 is record 0's LL; image level
// j + 1 synthesises image level j (as LL) with record j's details.
// The top image level (= levelCount) is full resolution.
// A window at level j + 1 needs only a one-coefficient-padded window
// of level j and the record-j blocks under it, so the recursion reads
// a cone of blocks, never a whole level. Decoded blocks are cached on
// the context, so each block is fetched and decoded once.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";
import { splitBlockStreams } from "../format/EcwBlockFrame.js";
import { decodeStream } from "../codec/streams.js";
import { synthesizeWindow, requiredCoefficientWindow } from "../codec/wavelet.js";

/**
 * @param {{header:object, levels:Array, index:object, grid:Array,
 *   fetchBlock:function(number): Promise<Uint8Array>, signal?:AbortSignal,
 *   onBlock?:function(number)}} o
 * @returns {object} decode context
 */
export function createDecodeContext(o) {
	return {
		header: o.header,
		levels: o.levels,
		index: o.index,
		grid: o.grid,
		fetchBlock: o.fetchBlock,
		signal: o.signal,
		onBlock: o.onBlock,
		blocks: new Map(),
		fetched: 0
	};
}

/**
 * Size of image level j (0 = record-0 LL, levelCount = full resolution).
 * @returns {{width:number, height:number}}
 */
export function imageLevelSize(header, levels, j) {
	if (j === header.levelCount) return { width: header.width, height: header.height };
	return { width: levels[j].width, height: levels[j].height };
}

function checkAbort(ctx) {
	if (ctx.signal && ctx.signal.aborted) throw new EcwError(ERROR_CODES.ABORTED, "decode aborted");
}

// Decoded block: { pw, ph, planes: [band][subband] -> Int32Array(pw*ph) }, streams decoded lazily
async function getBlock(ctx, record, row, col) {
	var g = ctx.grid[record];
	var n = g.firstBlock + row * g.cols + col;
	var cached = ctx.blocks.get(n);
	if (cached) return cached;
	checkAbort(ctx);
	var h = ctx.header;
	var lv = ctx.levels[record];
	var bytes = await ctx.fetchBlock(n);
	ctx.fetched++;
	if (ctx.onBlock) ctx.onBlock(ctx.fetched);
	var entry = {
		pw: Math.min(h.blockWidth, lv.width - col * h.blockWidth),
		ph: Math.min(h.blockHeight, lv.height - row * h.blockHeight),
		streams: splitBlockStreams(bytes, h.bands, record),
		decoded: {}
	};
	ctx.blocks.set(n, entry);
	return entry;
}

function blockPlane(entry, band, subband) {
	var key = band + subband;
	if (!entry.decoded[key]) {
		var stream = entry.streams.find(function (s) { return s.band === band && s.subband === subband; });
		entry.decoded[key] = decodeStream(stream, entry.pw * entry.ph);
	}
	return entry.decoded[key];
}

// Coefficients of `subbands` for record r over [x0, x1) x [y0, y1): result[band][subband] Float32Array
async function readCoefficients(ctx, record, subbands, x0, y0, x1, y1) {
	var h = ctx.header;
	var width = x1 - x0;
	var out = [];
	for (var b = 0; b < h.bands; b++) {
		out.push({});
		subbands.forEach(function (sb) { out[b][sb] = new Float32Array(width * (y1 - y0)); });
	}
	var bw = h.blockWidth, bh = h.blockHeight;
	for (var row = Math.floor(y0 / bh); row <= Math.floor((y1 - 1) / bh); row++) {
		for (var col = Math.floor(x0 / bw); col <= Math.floor((x1 - 1) / bw); col++) {
			var entry = await getBlock(ctx, record, row, col);
			var ox = col * bw, oy = row * bh;
			var sx0 = Math.max(x0, ox), sx1 = Math.min(x1, ox + entry.pw);
			var sy0 = Math.max(y0, oy), sy1 = Math.min(y1, oy + entry.ph);
			for (var bnd = 0; bnd < h.bands; bnd++) {
				for (var s = 0; s < subbands.length; s++) {
					var src = blockPlane(entry, bnd, subbands[s]);
					var dst = out[bnd][subbands[s]];
					for (var y = sy0; y < sy1; y++) {
						var si = (y - oy) * entry.pw - ox;
						var di = (y - y0) * width - x0;
						for (var x = sx0; x < sx1; x++) dst[di + x] = src[si + x];
					}
				}
			}
		}
	}
	return out;
}

/**
 * Reconstruct window [x0, x1) x [y0, y1) of image level j.
 * @returns {Promise<{width:number, height:number, bands:Float32Array[]}>}
 */
export async function decodeWindow(ctx, j, x0, y0, x1, y1) {
	var h = ctx.header;
	if (!Number.isInteger(j) || j < 0 || j > h.levelCount) {
		throw new EcwError(ERROR_CODES.INVALID_ARGUMENT, "no image level " + j);
	}
	var size = imageLevelSize(h, ctx.levels, j);
	if (x0 < 0 || y0 < 0 || x1 > size.width || y1 > size.height || x1 <= x0 || y1 <= y0) {
		throw new EcwError(ERROR_CODES.INVALID_ARGUMENT, "window " + x0 + "," + y0 + ".." + x1 + "," + y1 + " is outside image level " + j);
	}
	checkAbort(ctx);
	if (j === 0) {
		var ll = await readCoefficients(ctx, 0, ["LL"], x0, y0, x1, y1);
		return { width: x1 - x0, height: y1 - y0, bands: ll.map(function (p) { return p.LL; }) };
	}
	// Step 1) Coefficient window of record j-1 and the matching LL window of image level j-1
	var record = j - 1;
	var lv = ctx.levels[record];
	var c = requiredCoefficientWindow(lv.width, lv.height, x0, y0, x1, y1);
	var low = await decodeWindow(ctx, record, c.x0, c.y0, c.x1, c.y1);
	var details = await readCoefficients(ctx, record, ["LH", "HL", "HH"], c.x0, c.y0, c.x1, c.y1);
	// Step 2) Synthesise each band
	var bands = [];
	for (var b = 0; b < h.bands; b++) {
		bands.push(synthesizeWindow({
			w: lv.width, h: lv.height, x0: c.x0, y0: c.y0, width: c.x1 - c.x0, height: c.y1 - c.y0,
			LL: low.bands[b], LH: details[b].LH, HL: details[b].HL, HH: details[b].HH
		}, x0, y0, x1, y1));
	}
	return { width: x1 - x0, height: y1 - y0, bands: bands };
}
