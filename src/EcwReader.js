// src/EcwReader.js
//==========================================================
// Thin reader over a File/Blob. Reads one header window with
// BlobSource, parses it through MemorySource, and exposes `info`.
// readRegion picks the coarsest image level that is still as sharp as
// the request, reconstructs only that window (RegionDecoder), samples
// it to the output size (nearest or box average) and converts to RGBA.
// readRegionToScratch does the same strip by strip into an OPFS file.
//==========================================================

import { EcwError, ERROR_CODES } from "./errors.js";
import { BlobSource } from "./io/BlobSource.js";
import { MemorySource } from "./io/MemorySource.js";
import { parseHeader } from "./format/EcwHeader.js";
import { parseLevels } from "./format/EcwLevels.js";
import { parseBlockIndex, blockGrid, blockRunEntryWindow, blockRunByteRanges, blockEntryWindow, blockByteRange } from "./format/EcwBlockIndex.js";
import { pixelWindowToBounds } from "./format/georef.js";
import { parseWorldFile, parsePrj } from "./format/sidecars.js";
import { createDecodeContext, decodeWindow, imageLevelSize, countWindowBlocks, locateBlockError, finishBadBlocks } from "./decode/RegionDecoder.js";
import { sampleWindow } from "./decode/sampleWindow.js";
import { yuvToRgba, greyToRgba, bandsToRgba } from "./codec/colour.js";
import { applyColorKey, colorKeysFromOptions } from "./post/applyColorKey.js";
import { clipToPolygon } from "./post/clipToPolygon.js";
import { applyStretch, stretchFromPixels } from "./post/stretch.js";
import { openScratchSyncWriter, openScratchReader, removeScratchFile } from "./io/ScratchBinaryFile.js";
import { BlockCache, fileFingerprint, DEFAULT_MEMORY_BYTES } from "./cache/BlockCache.js";
import { createDecodePool, defaultThreads } from "./decode/pool.js";

// Fixed header (0x59) plus up to 255 level records (21 bytes each) fits in 8 KB
var HEADER_READ_BYTES = 8192;
var DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
var DEFAULT_STRIP_BYTES = 64 * 1024 * 1024;
// threads: automatic mode starts workers only for outputs this big (starting
// them costs about as much as a small read), uses at most this many per reader,
// and lets an idle pool go after this long
var AUTO_MIN_PIXELS = 1024 * 1024;
var AUTO_MAX_THREADS = 4;
var POOL_IDLE_MS = 30000;

/**
 * Reader for one ECW file. Create with openEcw().
 * @param {BlobSource} blobSource
 * @param {object} header - parseHeader() result.
 * @param {Array} levels - parseLevels() result.
 * @param {Uint8Array} headerBytes - The header window, for the block index.
 * @param {BlockCache|null} [cache] - Reconstructed-tile cache shared by every read.
 */
export function EcwReader(blobSource, header, levels, headerBytes, cache) {
	this._blobSource = blobSource;
	this._headerBytes = headerBytes;
	this._index = null;
	this._grid = null;
	this._header = header;
	this._levels = levels;
	this._closed = false;
	this._scratchIds = [];
	this._cache = cache || null;
	// worker pool (openEcw sets threads and the cache options it copies)
	this._threads = 1;
	this._cacheOpts = false;
	this._pool = null;
	this._poolStart = null;
	this._poolFailed = false;
	this._poolBusy = 0;
	this._poolTimer = null;
	this._poolUrl = undefined;
	this._autoMinPixels = AUTO_MIN_PIXELS;
	this._poolIdleMs = POOL_IDLE_MS;
	/** Public description of the image; `levels` runs coarsest first and ends at full resolution. */
	this.info = {
		version: header.version,
		width: header.width,
		height: header.height,
		bands: header.bands,
		blockWidth: header.blockWidth,
		blockHeight: header.blockHeight,
		compressionTarget: header.compressionTarget,
		colorSpace: header.colorSpace,
		levels: levels.map(function (l) { return { width: l.width, height: l.height }; })
			.concat([{ width: header.width, height: header.height }]),
		cellSizeX: header.cellSizeX,
		cellSizeY: header.cellSizeY,
		originX: header.originX,
		originY: header.originY,
		datum: header.datum,
		projection: header.projection,
		units: header.units
	};
}

function invalid(message) {
	return new EcwError(ERROR_CODES.INVALID_ARGUMENT, message);
}

function isCount(v) {
	return Number.isInteger(v) && v > 0;
}

/**
 * Decode a region to RGBA.
 * @param {{x:number, y:number, width:number, height:number, outWidth?:number, outHeight?:number,
 *   resample?:"nearest"|"average", transparentBelow?:number, transparentAbove?:number,
 *   transparentColor?:{color:string|number[], below?:number, above?:number}|Array, clipPolygon?:Array,
 *   stretch?:{min:number[], max:number[]},
 *   onProgress?:function(number, string), signal?:AbortSignal, maxOutputBytes?:number}} opts
 *   x, y, width, height are full-resolution pixels; outWidth/outHeight default to width/height.
 *   resample "nearest" (default) matches GDAL / the ECW SDK exactly; "average" box-averages
 *   the decoded level for smooth downsampling between levels.
 *   transparentBelow N clears pixels whose R, G and B are all <= N; transparentAbove N all >= N;
 *   transparentColor clears pixels within below..above of a colour ("#rrggbb" or [r, g, b]), one or a list.
 *   stretch (optional, e.g. from computeStretch) maps each band's min..max to 0..255.
 * @returns {Promise<{data:Uint8ClampedArray, width:number, height:number, level:number,
 *   bounds:{minX:number, minY:number, maxX:number, maxY:number}}>}
 */
EcwReader.prototype.readRegion = async function (opts) {
	var plan = this._plan(opts);
	var maxBytes = plan.o.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
	if (plan.outW * plan.outH * 4 > maxBytes) {
		throw new EcwError(ERROR_CODES.OUTPUT_TOO_LARGE, "output of " + plan.outW + "x" + plan.outH + " exceeds " + maxBytes + " bytes; use readRegionToScratch");
	}
	var report = plan.o.onProgress || function () {};
	var out = await this._rows(plan, 0, plan.outH, function (f, label) { report(0.95 * f, label); });
	report(1, "done");
	var result = { data: out.data, width: plan.outW, height: plan.outH, level: plan.level, bounds: plan.bounds };
	if (plan.skipBad) result.badBlocks = out.badBlocks;
	return result;
};

// Step 1) Validate a request and choose its image level (shared by both read paths)
EcwReader.prototype._plan = function (opts) {
	var o = opts || {};
	var h = this._header;
	if (this._closed) throw invalid("reader is closed");
	if (!Number.isInteger(o.x) || !Number.isInteger(o.y) || o.x < 0 || o.y < 0 || !isCount(o.width) || !isCount(o.height)) {
		throw invalid("readRegion needs integer x, y >= 0 and width, height > 0");
	}
	if (o.x + o.width > h.width || o.y + o.height > h.height) throw invalid("region runs past the image");
	var outW = o.outWidth === undefined ? o.width : o.outWidth;
	var outH = o.outHeight === undefined ? o.height : o.outHeight;
	if (!isCount(outW) || !isCount(outH)) throw invalid("outWidth and outHeight must be integers > 0");
	var resample = o.resample === undefined ? "nearest" : o.resample;
	if (resample !== "nearest" && resample !== "average") throw invalid("resample must be \"nearest\" or \"average\"");
	if (o.stretch !== undefined) applyStretch(new Uint8ClampedArray(0), o.stretch);
	var colorKeys = colorKeysFromOptions(o);
	if (o.onBadBlock !== undefined && o.onBadBlock !== "throw" && o.onBadBlock !== "skip") throw invalid("onBadBlock must be \"throw\" or \"skip\"");
	if (o.signal && o.signal.aborted) throw new EcwError(ERROR_CODES.ABORTED, "decode aborted");
	// Coarsest level still at least as sharp as the output
	var factor = Math.min(o.width / outW, o.height / outH);
	var drop = factor >= 1 ? Math.min(h.levelCount, Math.floor(Math.log2(factor))) : 0;
	var level = h.levelCount - drop;
	return {
		o: o, outW: outW, outH: outH, resample: resample, level: level, scale: Math.pow(2, drop), colorKeys: colorKeys,
		skipBad: o.onBadBlock === "skip",
		size: imageLevelSize(h, this._levels, level),
		bounds: pixelWindowToBounds(this.info, o.x, o.y, o.width, o.height)
	};
};

// Steps 2-4) Decode output rows [oy0, oy1) of a plan to RGBA: reconstruct the level rows
// they need (a fresh decode context, so strips keep the block cache bounded), sample,
// colour, then the optional post-steps. progress(fraction, label) covers this range.
// Returns { data, badBlocks } (badBlocks: the blocks skip mode read around).
EcwReader.prototype._decodeRows = async function (plan, oy0, oy1, progress) {
	var o = plan.o, h = this._header, scale = plan.scale, outW = plan.outW;
	var lx0 = Math.floor(o.x / scale);
	var lx1 = Math.min(plan.size.width, Math.ceil((o.x + o.width) / scale));
	var ly0 = Math.min(plan.size.height - 1, Math.floor((o.y + oy0 * o.height / plan.outH) / scale));
	var ly1 = Math.min(plan.size.height, Math.max(ly0 + 1, Math.ceil((o.y + oy1 * o.height / plan.outH) / scale)));
	this._ensureIndex();
	var blobSource = this._blobSource;
	var index = this._index;
	var ctx = createDecodeContext({
		header: h, levels: this._levels, index: index, grid: this._grid, signal: o.signal, tileCache: this._cache,
		onBadBlock: plan.skipBad ? "skip" : "throw",
		// only asked when a block fails: its file offset, for the error or badBlocks
		blockOffset: async function (n) {
			var w = blockEntryWindow(index, n);
			return blockByteRange(index, n, await blobSource.read(w.start, w.end), blobSource.size).start;
		},
		// a row of neighbouring blocks is back to back in the file: two reads for the lot
		fetchBlocks: async function (n0, n1) {
			var w = blockRunEntryWindow(index, n0, n1);
			var ranges = blockRunByteRanges(index, n0, await blobSource.read(w.start, w.end), blobSource.size);
			var base = ranges[0].start;
			var bytes = await blobSource.read(base, ranges[ranges.length - 1].end);
			return ranges.map(function (r) { return bytes.subarray(r.start - base, r.end - base); });
		}
	});
	var total = countWindowBlocks(ctx, plan.level, lx0, ly0, lx1, ly1);
	progress(0, "reading " + total + " blocks");
	// tile padding can fetch more blocks than counted, cache hits fewer
	ctx.onBlock = function (done) { progress(Math.min(1, done / total), "decoded " + done + " blocks"); };
	var win;
	try {
		win = await decodeWindow(ctx, plan.level, lx0, ly0, lx1, ly1);
	} catch (err) {
		throw await locateBlockError(ctx, err);
	}
	var badBlocks = plan.skipBad ? await finishBadBlocks(ctx) : [];
	// Eighths are all the colour step uses (it floors to integers) and what cached
	// tiles hold, so flooring here keeps "average" identical with or without a cache
	win.bands.forEach(function (band) { for (var i = 0; i < band.length; i++) band[i] = Math.floor(band[i] * 8) / 8; });
	if (this._cache) await this._cache.flush();
	var sampled = sampleWindow(win.bands, lx1 - lx0, ly1 - ly0, o, scale, lx0, ly0, outW, plan.outH, plan.resample, oy0, oy1);
	var data = new Uint8ClampedArray(outW * (oy1 - oy0) * 4);
	// only yuv files hold luma/chroma; other colour spaces show their first three bands (or one as grey)
	if (h.bands >= 3 && h.colorSpace === "yuv") yuvToRgba(sampled[0], sampled[1], sampled[2], data);
	else if (h.bands >= 3) bandsToRgba(sampled[0], sampled[1], sampled[2], data);
	else greyToRgba(sampled[0], data);
	if (plan.colorKeys) applyColorKey(data, plan.colorKeys);
	if (o.stretch !== undefined) applyStretch(data, o.stretch);
	if (o.clipPolygon) clipToPolygon(data, outW, plan.outH, plan.bounds, o.clipPolygon, oy0);
	return { data: data, badBlocks: badBlocks };
};

/**
 * A contrast stretch for this file, like QGIS's min/max stretch with a
 * cumulative count cut: per-band cut points of a small overview, leaving
 * out the near-black background. Pass the result as readRegion's stretch
 * so every read of the file looks the same.
 * @param {{cut?:number[], ignoreBelow?:number, sampleSize?:number}} [opts]
 *   cut in percent (default [2, 98]); ignoreBelow default 3; sampleSize is the
 *   overview's longest side (default 512).
 * @returns {Promise<{min:number[], max:number[]}>}
 */
EcwReader.prototype.computeStretch = async function (opts) {
	var o = opts || {};
	var h = this._header;
	var fit = Math.min(1, (o.sampleSize || 512) / Math.max(h.width, h.height));
	var thumb = await this.readRegion({ x: 0, y: 0, width: h.width, height: h.height,
		outWidth: Math.max(1, Math.round(h.width * fit)), outHeight: Math.max(1, Math.round(h.height * fit)) });
	return stretchFromPixels(thumb.data, { cut: o.cut, ignoreBelow: o.ignoreBelow });
};

/** Parse the block index lazily from the header window. */
EcwReader.prototype._ensureIndex = function () {
	if (this._index) return;
	this._index = parseBlockIndex(new MemorySource(this._headerBytes), this._header);
	this._grid = blockGrid(this._header, this._levels);
};

/**
 * Decode a region into an OPFS scratch file, strip by strip, so outputs
 * larger than memory work. Needs synchronous OPFS access: a Worker, or
 * Node with an injected root (opts.scratch.root).
 * The file holds RGBA rows top to bottom, width * 4 bytes each, byte for
 * byte what readRegion would return.
 * @param {object} opts - readRegion options, plus stripBytes (RGBA bytes per strip,
 *   default 64 MB) and scratch ({root?, dir?} for the scratch directory).
 * @returns {Promise<{scratchId:string, width:number, height:number, level:number,
 *   bounds:object, byteLength:number, openReader:function():Promise}>}
 */
EcwReader.prototype.readRegionToScratch = async function (opts) {
	var plan = this._plan(opts);
	var o = plan.o;
	var stripBytes = o.stripBytes === undefined ? DEFAULT_STRIP_BYTES : o.stripBytes;
	if (!isCount(stripBytes)) throw invalid("stripBytes must be an integer > 0");
	var scratchOpts = o.scratch || {};
	var rowsPerStrip = Math.max(1, Math.floor(stripBytes / (plan.outW * 4)));
	var strips = Math.ceil(plan.outH / rowsPerStrip);
	var report = o.onProgress || function () {};
	var id = "region-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
	var writer = await openScratchSyncWriter(id, scratchOpts);
	this._scratchIds.push({ id: id, options: scratchOpts });
	var badBlocks = [];
	try {
		for (var s = 0; s < strips; s++) {
			var oy0 = s * rowsPerStrip;
			var oy1 = Math.min(plan.outH, oy0 + rowsPerStrip);
			var label = "strip " + (s + 1) + " of " + strips + ": ";
			var out = await this._rows(plan, oy0, oy1, function (f, text) { report((s + f) / strips * 0.99, label + text); });
			var data = out.data;
			badBlocks = mergeBadBlocks(badBlocks, out.badBlocks);
			writer.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		}
		writer.close();
	} catch (err) {
		writer.close();
		await this._removeScratch(id);
		throw err;
	}
	report(1, "done");
	var byteLength = plan.outW * plan.outH * 4;
	var result = {
		scratchId: id, width: plan.outW, height: plan.outH, level: plan.level, bounds: plan.bounds, byteLength: byteLength,
		openReader: function () { return openScratchReader(id, Object.assign({ byteLength: byteLength }, scratchOpts)); }
	};
	if (plan.skipBad) result.badBlocks = badBlocks;
	return result;
};

// Bad-block lists from several strips or workers, one entry per block, in block order
// (a block shared by two bands of rows lists the streams each one hit, once)
function mergeBadBlocks(a, b) {
	if (!b || !b.length) return a;
	var byBlock = new Map();
	a.concat(b).forEach(function (r) {
		var seen = byBlock.get(r.block);
		if (!seen) { byBlock.set(r.block, Object.assign({}, r, { streams: r.streams.slice() })); return; }
		r.streams.forEach(function (st) {
			if (!seen.streams.some(function (x) { return x.band === st.band && x.subband === st.subband; })) seen.streams.push(st);
		});
	});
	return Array.from(byBlock.values()).sort(function (x, y) { return x.block - y.block; });
}

// Remove one of this reader's scratch files (and forget it)
EcwReader.prototype._removeScratch = async function (id) {
	var i = this._scratchIds.findIndex(function (e) { return e.id === id; });
	if (i < 0) return;
	var entry = this._scratchIds.splice(i, 1)[0];
	await removeScratchFile(entry.id, entry.options);
};

/** Tile cache counters, or null when the reader was opened with cache: false. */
EcwReader.prototype.cacheStats = function () {
	return this._cache ? this._cache.stats() : null;
};

/**
 * Output rows [oy0, oy1) of a planned read: on the worker pool when one is
 * in use, each worker decoding one band of rows, else on this thread.
 * Either way the bytes are the same.
 */
EcwReader.prototype._rows = async function (plan, oy0, oy1, report) {
	var pool = await this._poolFor(plan.outW * (oy1 - oy0));
	if (!pool) return this._decodeRows(plan, oy0, oy1, report);
	this._poolBusy++;
	clearTimeout(this._poolTimer);
	try {
		return await decodeBands(pool, plan, oy0, oy1, report);
	} finally {
		this._poolBusy--;
		if (!this._poolBusy) this._idlePool(pool);
	}
};

// The pool for a read of this many output pixels, or null for this thread
EcwReader.prototype._poolFor = async function (pixels) {
	if (this._threads === 1 || this._poolFailed) return null;
	if (this._threads === 0) {
		if (pixels < this._autoMinPixels) return null;
		// the OPFS tile cache lives on this thread, so automatic mode keeps reads here
		if (this._cacheOpts && this._cacheOpts.opfs) return null;
	}
	if (!this._poolStart) this._startPool();
	// automatic mode never waits for workers: until the pool is up, reads run here
	if (this._threads === 0 && !this._pool) return null;
	var start = this._poolStart;
	var pool = await start;
	if (!pool || pool.broken) {
		// workers that can't start, or one that died: this thread from now on
		if (pool) pool.close();
		if (this._poolStart === start) this._poolStart = null;
		this._poolFailed = true;
		return null;
	}
	this._pool = pool;
	return pool;
};

// Start the worker pool; _pool is set once it is up (or _poolFailed if it can't start)
EcwReader.prototype._startPool = function () {
	var self = this;
	var start = (async function () {
		var n = self._threads || Math.min(AUTO_MAX_THREADS, await defaultThreads());
		if (n < 2) return null;
		var c = self._cacheOpts;
		// each worker keeps its own memory tiles: an equal share of the budget
		var cache = c === false ? false : { tileSize: c.tileSize, memoryBytes: Math.floor((c.memoryBytes === undefined ? DEFAULT_MEMORY_BYTES : c.memoryBytes) / n) };
		return createDecodePool(n, self._blobSource._blob, cache, self._poolUrl);
	})().catch(function () { return null; }).then(function (pool) {
		if (self._poolStart !== start) {
			// closed, or replaced while starting
			if (pool) pool.close();
			return null;
		}
		if (!pool) {
			self._poolStart = null;
			self._poolFailed = true;
			return null;
		}
		self._pool = pool;
		// a pool started ahead of use still goes when idle
		if (!self._poolBusy) self._idlePool(pool);
		return pool;
	});
	this._poolStart = start;
};

// Close the pool once nothing has used it for _poolIdleMs; the next big read starts it again
EcwReader.prototype._idlePool = function (pool) {
	var self = this;
	clearTimeout(this._poolTimer);
	this._poolTimer = setTimeout(function () {
		if (self._poolBusy || self._pool !== pool) return;
		self._pool = null;
		self._poolStart = null;
		pool.close();
	}, this._poolIdleMs);
	// a pending timer never keeps Node running
	if (this._poolTimer && this._poolTimer.unref) this._poolTimer.unref();
};

// The read options a worker needs: the pixel options. Not the signal, progress
// callback or scratch settings (they hold functions and stay on this thread).
var THIS_THREAD_ONLY = { signal: true, onProgress: true, scratch: true, stripBytes: true, maxOutputBytes: true };
function postableOptions(o) {
	var out = {};
	Object.keys(o).forEach(function (k) { if (!THIS_THREAD_ONLY[k]) out[k] = o[k]; });
	return out;
}

// Split rows [oy0, oy1) into one band per worker; band i always goes to worker i
async function decodeBands(pool, plan, oy0, oy1, report) {
	var rows = oy1 - oy0;
	var k = Math.min(pool.size, rows);
	var opts = postableOptions(plan.o);
	var out = new Uint8ClampedArray(plan.outW * rows * 4);
	var badBlocks = [];
	var share = new Float64Array(k);
	var label = "decoding in " + k + " workers";
	var stop = new AbortController();
	var signal = plan.o.signal;
	function onAbort() { stop.abort(); }
	if (signal) {
		if (signal.aborted) throw new EcwError(ERROR_CODES.ABORTED, "decode aborted");
		signal.addEventListener("abort", onAbort);
	}
	try {
		var bands = [];
		for (var i = 0; i < k; i++) {
			bands.push((function (i, b0, b1) {
				return pool.rows(i, { opts: opts, oy0: b0, oy1: b1 }, function (f) {
					share[i] = f * (b1 - b0) / rows;
					var sum = 0;
					for (var s = 0; s < k; s++) sum += share[s];
					report(sum, label);
				}, stop.signal).then(function (res) {
					out.set(res.data, (b0 - oy0) * plan.outW * 4);
					badBlocks = mergeBadBlocks(badBlocks, res.badBlocks);
				}, function (err) {
					// one band failing stops the others
					stop.abort();
					throw err;
				});
			})(i, oy0 + Math.floor(rows * i / k), oy0 + Math.floor(rows * (i + 1) / k)));
		}
		await Promise.all(bands);
	} finally {
		if (signal) signal.removeEventListener("abort", onAbort);
	}
	return { data: out, badBlocks: badBlocks };
}

/** Release resources and delete this reader's scratch files. Safe to call more than once. */
EcwReader.prototype.close = async function () {
	this._closed = true;
	this._cache = null;
	clearTimeout(this._poolTimer);
	var start = this._poolStart;
	this._poolStart = null;
	this._pool = null;
	if (start) {
		var pool = await start;
		if (pool) pool.close();
	}
	while (this._scratchIds.length) await this._removeScratch(this._scratchIds[0].id);
};

// A sidecar passed as text or as a Blob/File; null when not given
async function sidecarText(value, name) {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	if (value && typeof value.text === "function") return await value.text();
	throw invalid(name + " must be a string, Blob or File");
}

// Cell sizes within this fraction of each other agree (world files round to ~6 places)
var SIDECAR_CELL_TOLERANCE = 1e-4;
// Origins within this fraction of a cell agree
var SIDECAR_ORIGIN_TOLERANCE = 1e-3;

function formatNumber(v) { return String(Number(v.toPrecision(12))); }

// Add worldFile, crs, georefSource and warnings to info. The header stays the
// georeferencing source unless georef is "worldFile".
function applySidecars(info, worldText, prjText, georef) {
	var warnings = [];
	var world = worldText === null ? null : parseWorldFile(worldText);
	var crs = prjText === null ? null : parsePrj(prjText);
	if (world) {
		var rotated = world.rotationX !== 0 || world.rotationY !== 0;
		if (rotated && georef === "worldFile") throw new EcwError(ERROR_CODES.NOT_IMPLEMENTED, "rotated world files are not supported");
		if (rotated) warnings.push("world file is rotated; its rotation is not used");
		[["cellSizeX", "cell size X"], ["cellSizeY", "cell size Y"]].forEach(function (p) {
			var h = info[p[0]], w = world[p[0]];
			if (Math.abs(h - w) > SIDECAR_CELL_TOLERANCE * Math.max(Math.abs(h), Math.abs(w))) {
				warnings.push("world file " + p[1] + " " + formatNumber(w) + " differs from the header's " + formatNumber(h));
			}
		});
		[["originX", "cellSizeX", "X"], ["originY", "cellSizeY", "Y"]].forEach(function (p) {
			var diff = world[p[0]] - info[p[0]];
			var cell = Math.abs(info[p[1]]) || 1;
			if (Math.abs(diff) > SIDECAR_ORIGIN_TOLERANCE * cell) {
				warnings.push("world file origin " + p[2] + " differs from the header's by " + formatNumber(diff) + " (" + formatNumber(diff / cell) + " cells)");
			}
		});
		if (georef === "worldFile") {
			info.cellSizeX = world.cellSizeX;
			info.cellSizeY = world.cellSizeY;
			info.originX = world.originX;
			info.originY = world.originY;
		}
	}
	if (crs && crs.units) info.units = crs.units;
	info.worldFile = world;
	info.crs = crs;
	info.georefSource = georef;
	info.warnings = warnings;
}

/**
 * Open an ECW file and read its header, georeferencing and level table.
 * @param {Blob} blob - A File or Blob.
 * @param {{cache?: false|{tileSize?:number, memoryBytes?:number,
 *   opfs?:boolean|{root?:object, dir?:string, maxBytes?:number}}, threads?:number,
 *   worldFile?:string|Blob, prj?:string|Blob, georef?:"header"|"worldFile"}} [options]
 *   cache: reconstructed tiles are kept in memory (256 MB) by default; false turns
 *   caching off; opfs also keeps them in OPFS (512 MB) for later sessions.
 *   threads: 0 or unset = automatic (up to 4 workers for outputs of 1 megapixel
 *   or more, unless the OPFS cache is on), 1 = this thread only, n = n workers.
 *   worldFile, prj: sidecar text or files (see pickSidecars). With either, info gains
 *   worldFile, crs, georefSource and warnings, and units comes from the prj.
 *   georef: "header" (default) keeps the header's georeferencing and warns when the
 *   world file disagrees; "worldFile" uses the world file's instead.
 * @returns {Promise<EcwReader>}
 */
export async function openEcw(blob, options) {
	var cacheOpts = options && options.cache;
	if (cacheOpts !== undefined && cacheOpts !== false && (typeof cacheOpts !== "object" || cacheOpts === null)) {
		throw invalid("cache must be false or an options object");
	}
	var threads = options ? options.threads : undefined;
	if (threads !== undefined && (!Number.isInteger(threads) || threads < 0)) throw invalid("threads must be an integer of 0 or more");
	var georef = options && options.georef !== undefined ? options.georef : "header";
	if (georef !== "header" && georef !== "worldFile") throw invalid("georef must be \"header\" or \"worldFile\"");
	var worldText = await sidecarText(options && options.worldFile, "worldFile");
	var prjText = await sidecarText(options && options.prj, "prj");
	if (georef === "worldFile" && worldText === null) throw invalid("georef \"worldFile\" needs a worldFile");
	var blobSource = new BlobSource(blob);
	var bytes = await blobSource.read(0, Math.min(HEADER_READ_BYTES, blobSource.size));
	var source = new MemorySource(bytes);
	var header = parseHeader(source);
	var levels = parseLevels(source, header);
	var cache = null;
	if (cacheOpts !== false) {
		var c = cacheOpts || {};
		cache = new BlockCache({ tileSize: c.tileSize, memoryBytes: c.memoryBytes, opfs: c.opfs,
			fingerprint: c.opfs ? await fileFingerprint(blob) : undefined });
	}
	var reader = new EcwReader(blobSource, header, levels, bytes, cache);
	if (worldText !== null || prjText !== null) applySidecars(reader.info, worldText, prjText, georef);
	reader._threads = threads || 0;
	reader._cacheOpts = cacheOpts === false ? false : (cacheOpts || {});
	return reader;
}
