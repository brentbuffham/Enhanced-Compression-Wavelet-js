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
// Detail coefficients are dequantised by the record's per-band step:
// a (band 0), b (band 1), c (band 2) from the level table
// (FINDINGS.md "quantisation steps"). LL is used as decoded.
// A detail stream that is empty in a block drops that subband from
// the block's output pixels, neighbours' coefficients included; with all
// three empty the band takes the exact path (wavelet subbandsAt).
// Every level that feeds another synthesis is stored floored to eighths,
// as the SDK does; the requested level keeps full precision.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";
import { splitBlockStreams, STREAM_MODE } from "../format/EcwBlockFrame.js";
import { decodeStream } from "../codec/streams.js";
import { synthesizeWindow, requiredCoefficientWindow } from "../codec/wavelet.js";

/**
 * @param {{header:object, levels:Array, index:object, grid:Array,
 *   fetchBlock:function(number): Promise<Uint8Array>, signal?:AbortSignal,
 *   onBlock?:function(number), tileCache?:object}} o
 *   tileCache (BlockCache): { tileSize, get(j, tx, ty) -> Promise<tile|null>,
 *   put(j, tx, ty, tile) -> Promise } holding reconstructed level tiles
 *   { width, height, bands } at full precision.
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
		tileCache: o.tileCache || null,
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

var SUBBAND_BIT = { LH: 1, HL: 2, HH: 4 };

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
	var streams = splitBlockStreams(bytes, h.bands, record);
	var entry = {
		pw: Math.min(h.blockWidth, lv.width - col * h.blockWidth),
		ph: Math.min(h.blockHeight, lv.height - row * h.blockHeight),
		streams: streams,
		decoded: {},
		// per band: bits of its non-empty detail streams (1 LH, 2 HL, 4 HH)
		subbands: []
	};
	for (var b = 0; b < h.bands; b++) entry.subbands.push(0);
	streams.forEach(function (st) {
		if (st.mode !== STREAM_MODE.EMPTY && SUBBAND_BIT[st.subband]) entry.subbands[st.band] |= SUBBAND_BIT[st.subband];
	});
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
						// native copy for long rows; a plain loop beats creating a view for short ones
						if (sx1 - sx0 >= 32) dst.set(src.subarray(si + sx0, si + sx1), di + sx0);
						else for (var x = sx0; x < sx1; x++) dst[di + x] = src[si + x];
					}
				}
			}
		}
	}
	return out;
}

// subbandsAt(c, k) for one band of one record: the band's non-empty
// detail streams in the block holding coefficient (c, k)
function subbandsAtFor(ctx, record, band) {
	var g = ctx.grid[record], bw = ctx.header.blockWidth, bh = ctx.header.blockHeight;
	return function (c, k) {
		var entry = ctx.blocks.get(g.firstBlock + Math.floor(k / bh) * g.cols + Math.floor(c / bw));
		return entry ? entry.subbands[band] : 7;
	};
}

// Multiply detail planes in place by the record's per-band step
function dequantise(details, record) {
	var steps = [record.a, record.b, record.c];
	details.forEach(function (planes, band) {
		var step = steps[Math.min(band, 2)];
		if (step === 1) return;
		["LH", "HL", "HH"].forEach(function (sb) {
			var a = planes[sb];
			for (var i = 0; i < a.length; i++) a[i] *= step;
		});
	});
}

/**
 * Reconstruct window [x0, x1) x [y0, y1) of image level j.
 * @returns {Promise<{width:number, height:number, bands:Float32Array[]}>}
 */
export function decodeWindow(ctx, j, x0, y0, x1, y1) {
	return decodeLevel(ctx, j, x0, y0, x1, y1, true);
}

// Levels used as the next level's LL are stored at eighths
function storeIntermediate(bands) {
	bands.forEach(function (arr) {
		for (var i = 0; i < arr.length; i++) arr[i] = Math.floor(arr[i] * 8) / 8;
	});
}

async function decodeLevel(ctx, j, x0, y0, x1, y1, requested) {
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
	// tiles are already floored to eighths
	var bands = ctx.tileCache
		? await assembleTiles(ctx, j, size, x0, y0, x1, y1)
		: await synthesizeLevel(ctx, j, x0, y0, x1, y1);
	if (!requested && !ctx.tileCache) storeIntermediate(bands);
	return { width: x1 - x0, height: y1 - y0, bands: bands };
}

// Window [x0, x1) x [y0, y1) of image level j >= 1 at full precision: fresh arrays per band
async function synthesizeLevel(ctx, j, x0, y0, x1, y1) {
	var h = ctx.header;
	// Step 1) Coefficient window of record j-1 and the matching LL window of image level j-1
	var record = j - 1;
	var lv = ctx.levels[record];
	var c = requiredCoefficientWindow(lv.width, lv.height, x0, y0, x1, y1);
	var low = await decodeLevel(ctx, record, c.x0, c.y0, c.x1, c.y1, false);
	var details = await readCoefficients(ctx, record, ["LH", "HL", "HH"], c.x0, c.y0, c.x1, c.y1);
	dequantise(details, lv);
	// Step 2) Synthesise each band
	var bands = [];
	for (var b = 0; b < h.bands; b++) {
		bands.push(synthesizeWindow({
			w: lv.width, h: lv.height, x0: c.x0, y0: c.y0, width: c.x1 - c.x0, height: c.y1 - c.y0,
			LL: low.bands[b], LH: details[b].LH, HL: details[b].HL, HH: details[b].HH,
			subbandsAt: subbandsAtFor(ctx, record, b)
		}, x0, y0, x1, y1));
	}
	return bands;
}

// The same window built from cached tiles of image level j, floored to eighths;
// the missing tiles' bounding box is synthesised in one call, floored and stored
// (one large synthesis is far cheaper than many tile-sized ones). A pixel's value never
// depends on the window it was computed in, so tiles assemble to exactly what
// synthesizeLevel returns, floored. Eighths are all a level feeding the next one
// uses, and all readRegion uses of the requested level (colour floors to integers).
async function assembleTiles(ctx, j, size, x0, y0, x1, y1) {
	var cache = ctx.tileCache, t = cache.tileSize, width = x1 - x0;
	var tx0 = Math.floor(x0 / t), tx1 = Math.floor((x1 - 1) / t), ty0 = Math.floor(y0 / t), ty1 = Math.floor((y1 - 1) / t);
	// Step 1) Look every tile up; note the bounding box of the missing ones
	var tiles = [], mx0 = Infinity, mx1 = -1, my0 = Infinity, my1 = -1;
	for (var ty = ty0; ty <= ty1; ty++) {
		for (var tx = tx0; tx <= tx1; tx++) {
			var tile = await cache.get(j, tx, ty);
			tiles.push(tile);
			if (!tile) {
				mx0 = Math.min(mx0, tx); mx1 = Math.max(mx1, tx);
				my0 = Math.min(my0, ty); my1 = Math.max(my1, ty);
			}
		}
	}
	// Step 2) Synthesise that box in one call (snapped to tiles), floor it, store its tiles
	var box = null;
	if (mx1 >= 0) {
		var bx0 = mx0 * t, by0 = my0 * t, bx1 = Math.min(size.width, (mx1 + 1) * t), by1 = Math.min(size.height, (my1 + 1) * t);
		box = { x0: bx0, y0: by0, width: bx1 - bx0, height: by1 - by0, scale: 1, bands: await synthesizeLevel(ctx, j, bx0, by0, bx1, by1) };
		storeIntermediate(box.bands);
		for (ty = my0; ty <= my1; ty++) {
			for (tx = mx0; tx <= mx1; tx++) {
				var px0 = tx * t, py0 = ty * t, pw = Math.min(size.width, px0 + t) - px0, ph = Math.min(size.height, py0 + t) - py0;
				var cut = box.bands.map(function (band) {
					var out = new Float32Array(pw * ph);
					for (var y = 0; y < ph; y++) out.set(band.subarray((py0 - by0 + y) * box.width + px0 - bx0, (py0 - by0 + y) * box.width + px0 - bx0 + pw), y * pw);
					return out;
				});
				await cache.put(j, tx, ty, { width: pw, height: ph, bands: cut });
			}
		}
	}
	// Step 3) Copy the window out of the box and the cached tiles
	var bands = [];
	for (var bnd = 0; bnd < ctx.header.bands; bnd++) bands.push(new Float32Array(width * (y1 - y0)));
	if (box) copyInto(bands, width, x0, y0, x1, y1, box, box.x0, box.y0);
	var n = 0;
	for (ty = ty0; ty <= ty1; ty++) {
		for (tx = tx0; tx <= tx1; tx++, n++) {
			if (box && tx >= mx0 && tx <= mx1 && ty >= my0 && ty <= my1) continue;
			copyInto(bands, width, x0, y0, x1, y1, tiles[n], tx * t, ty * t);
		}
	}
	return bands;
}

// Copy the overlap of a source {width, height, bands, scale} placed at (sx, sy) into
// the window [x0, x1) x [y0, y1); source values are band[i] * scale (BlockCache
// keeps eighths as Int16 with scale 1/8)
function copyInto(bands, width, x0, y0, x1, y1, src, sx, sy) {
	var cx0 = Math.max(x0, sx), cx1 = Math.min(x1, sx + src.width);
	var cy0 = Math.max(y0, sy), cy1 = Math.min(y1, sy + src.height);
	var scale = src.scale || 1, run = cx1 - cx0;
	for (var b = 0; b < bands.length; b++) {
		var from = src.bands[b], to = bands[b];
		for (var y = cy0; y < cy1; y++) {
			var si = (y - sy) * src.width + cx0 - sx, di = (y - y0) * width + cx0 - x0;
			if (scale === 1) to.set(from.subarray(si, si + run), di);
			else for (var x = 0; x < run; x++) to[di + x] = from[si + x] * scale;
		}
	}
}

/**
 * Number of distinct blocks decodeWindow(ctx, j, ...) will fetch (for progress).
 * @returns {number}
 */
export function countWindowBlocks(ctx, j, x0, y0, x1, y1) {
	var seen = new Set();
	var h = ctx.header;
	function addBlocks(record, cx0, cy0, cx1, cy1) {
		var g = ctx.grid[record];
		for (var row = Math.floor(cy0 / h.blockHeight); row <= Math.floor((cy1 - 1) / h.blockHeight); row++) {
			for (var col = Math.floor(cx0 / h.blockWidth); col <= Math.floor((cx1 - 1) / h.blockWidth); col++) seen.add(g.firstBlock + row * g.cols + col);
		}
	}
	function walk(level, wx0, wy0, wx1, wy1) {
		if (level === 0) { addBlocks(0, wx0, wy0, wx1, wy1); return; }
		var lv = ctx.levels[level - 1];
		var c = requiredCoefficientWindow(lv.width, lv.height, wx0, wy0, wx1, wy1);
		addBlocks(level - 1, c.x0, c.y0, c.x1, c.y1);
		walk(level - 1, c.x0, c.y0, c.x1, c.y1);
	}
	walk(j, x0, y0, x1, y1);
	return seen.size;
}
