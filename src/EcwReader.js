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
import { parseBlockIndex, blockGrid, blockEntryWindow, blockByteRange } from "./format/EcwBlockIndex.js";
import { pixelWindowToBounds } from "./format/georef.js";
import { createDecodeContext, decodeWindow, imageLevelSize, countWindowBlocks } from "./decode/RegionDecoder.js";
import { sampleWindow } from "./decode/sampleWindow.js";
import { yuvToRgba, greyToRgba } from "./codec/colour.js";
import { applyTransparency } from "./post/applyTransparency.js";
import { clipToPolygon } from "./post/clipToPolygon.js";
import { openScratchSyncWriter, openScratchReader, removeScratchFile } from "./io/ScratchBinaryFile.js";
import { BlockCache, fileFingerprint } from "./cache/BlockCache.js";

// Fixed header (0x59) plus up to 255 level records (21 bytes each) fits in 8 KB
var HEADER_READ_BYTES = 8192;
var DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
var DEFAULT_STRIP_BYTES = 64 * 1024 * 1024;

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
	/** Public description of the image; `levels` runs coarsest first and ends at full resolution. */
	this.info = {
		version: header.version,
		width: header.width,
		height: header.height,
		bands: header.bands,
		blockWidth: header.blockWidth,
		blockHeight: header.blockHeight,
		compressionTarget: header.compressionTarget,
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
 *   resample?:"nearest"|"average", transparentBelow?:number, clipPolygon?:Array,
 *   onProgress?:function(number, string), signal?:AbortSignal, maxOutputBytes?:number}} opts
 *   x, y, width, height are full-resolution pixels; outWidth/outHeight default to width/height.
 *   resample "nearest" (default) matches GDAL / the ECW SDK exactly; "average" box-averages
 *   the decoded level for smooth downsampling between levels.
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
	var data = await this._decodeRows(plan, 0, plan.outH, function (f, label) { report(0.95 * f, label); });
	report(1, "done");
	return { data: data, width: plan.outW, height: plan.outH, level: plan.level, bounds: plan.bounds };
};

// Step 1) Validate a request and choose its image level (shared by both read paths)
EcwReader.prototype._plan = function (opts) {
	var o = opts || {};
	var h = this._header;
	if (!Number.isInteger(o.x) || !Number.isInteger(o.y) || o.x < 0 || o.y < 0 || !isCount(o.width) || !isCount(o.height)) {
		throw invalid("readRegion needs integer x, y >= 0 and width, height > 0");
	}
	if (o.x + o.width > h.width || o.y + o.height > h.height) throw invalid("region runs past the image");
	var outW = o.outWidth === undefined ? o.width : o.outWidth;
	var outH = o.outHeight === undefined ? o.height : o.outHeight;
	if (!isCount(outW) || !isCount(outH)) throw invalid("outWidth and outHeight must be integers > 0");
	var resample = o.resample === undefined ? "nearest" : o.resample;
	if (resample !== "nearest" && resample !== "average") throw invalid("resample must be \"nearest\" or \"average\"");
	if (o.signal && o.signal.aborted) throw new EcwError(ERROR_CODES.ABORTED, "decode aborted");
	// Coarsest level still at least as sharp as the output
	var factor = Math.min(o.width / outW, o.height / outH);
	var drop = factor >= 1 ? Math.min(h.levelCount, Math.floor(Math.log2(factor))) : 0;
	var level = h.levelCount - drop;
	return {
		o: o, outW: outW, outH: outH, resample: resample, level: level, scale: Math.pow(2, drop),
		size: imageLevelSize(h, this._levels, level),
		bounds: pixelWindowToBounds(this.info, o.x, o.y, o.width, o.height)
	};
};

// Steps 2-4) Decode output rows [oy0, oy1) of a plan to RGBA: reconstruct the level rows
// they need (a fresh decode context, so strips keep the block cache bounded), sample,
// colour, then the optional post-steps. progress(fraction, label) covers this range.
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
		fetchBlock: async function (n) {
			var w = blockEntryWindow(index, n);
			var r = blockByteRange(index, n, await blobSource.read(w.start, w.end), blobSource.size);
			return blobSource.read(r.start, r.end);
		}
	});
	var total = countWindowBlocks(ctx, plan.level, lx0, ly0, lx1, ly1);
	progress(0, "reading " + total + " blocks");
	// tile padding can fetch more blocks than counted, cache hits fewer
	ctx.onBlock = function (done) { progress(Math.min(1, done / total), "decoded " + done + " blocks"); };
	var win = await decodeWindow(ctx, plan.level, lx0, ly0, lx1, ly1);
	// Eighths are all the colour step uses (it floors to integers) and what cached
	// tiles hold, so flooring here keeps "average" identical with or without a cache
	win.bands.forEach(function (band) { for (var i = 0; i < band.length; i++) band[i] = Math.floor(band[i] * 8) / 8; });
	if (this._cache) await this._cache.flush();
	var sampled = sampleWindow(win.bands, lx1 - lx0, ly1 - ly0, o, scale, lx0, ly0, outW, plan.outH, plan.resample, oy0, oy1);
	var data = new Uint8ClampedArray(outW * (oy1 - oy0) * 4);
	if (h.bands >= 3) yuvToRgba(sampled[0], sampled[1], sampled[2], data);
	else greyToRgba(sampled[0], data);
	if (o.transparentBelow !== undefined) applyTransparency(data, o.transparentBelow);
	if (o.clipPolygon) clipToPolygon(data, outW, plan.outH, plan.bounds, o.clipPolygon, oy0);
	return data;
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
	try {
		for (var s = 0; s < strips; s++) {
			var oy0 = s * rowsPerStrip;
			var oy1 = Math.min(plan.outH, oy0 + rowsPerStrip);
			var label = "strip " + (s + 1) + " of " + strips + ": ";
			var data = await this._decodeRows(plan, oy0, oy1, function (f, text) { report((s + f) / strips * 0.99, label + text); });
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
	return {
		scratchId: id, width: plan.outW, height: plan.outH, level: plan.level, bounds: plan.bounds, byteLength: byteLength,
		openReader: function () { return openScratchReader(id, Object.assign({ byteLength: byteLength }, scratchOpts)); }
	};
};

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

/** Release resources and delete this reader's scratch files. Safe to call more than once. */
EcwReader.prototype.close = async function () {
	this._closed = true;
	this._cache = null;
	while (this._scratchIds.length) await this._removeScratch(this._scratchIds[0].id);
};

/**
 * Open an ECW file and read its header, georeferencing and level table.
 * @param {Blob} blob - A File or Blob.
 * @param {{cache?: false|{tileSize?:number, memoryBytes?:number,
 *   opfs?:boolean|{root?:object, dir?:string, maxBytes?:number}}}} [options]
 *   cache: reconstructed tiles are kept in memory (256 MB) by default; false turns
 *   caching off; opfs also keeps them in OPFS (512 MB) for later sessions.
 * @returns {Promise<EcwReader>}
 */
export async function openEcw(blob, options) {
	var cacheOpts = options && options.cache;
	if (cacheOpts !== undefined && cacheOpts !== false && (typeof cacheOpts !== "object" || cacheOpts === null)) {
		throw invalid("cache must be false or an options object");
	}
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
	return new EcwReader(blobSource, header, levels, bytes, cache);
}
