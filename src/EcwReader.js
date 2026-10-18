// src/EcwReader.js
//==========================================================
// Thin reader over a File/Blob. Reads one header window with
// BlobSource, parses it through MemorySource, and exposes `info`.
// readRegion picks the coarsest image level that is still as sharp as
// the request, reconstructs only that window (RegionDecoder), samples
// it to the output size and converts to RGBA. readRegionToScratch is
// still NOT_IMPLEMENTED.
//==========================================================

import { EcwError, ERROR_CODES } from "./errors.js";
import { BlobSource } from "./io/BlobSource.js";
import { MemorySource } from "./io/MemorySource.js";
import { parseHeader } from "./format/EcwHeader.js";
import { parseLevels } from "./format/EcwLevels.js";
import { parseBlockIndex, blockGrid, blockEntryWindow, blockByteRange } from "./format/EcwBlockIndex.js";
import { pixelWindowToBounds } from "./format/georef.js";
import { createDecodeContext, decodeWindow, imageLevelSize, countWindowBlocks } from "./decode/RegionDecoder.js";
import { yuvToRgba, greyToRgba } from "./codec/colour.js";
import { applyTransparency } from "./post/applyTransparency.js";
import { clipToPolygon } from "./post/clipToPolygon.js";

// Fixed header (0x59) plus up to 255 level records (21 bytes each) fits in 8 KB
var HEADER_READ_BYTES = 8192;
var DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

/**
 * Reader for one ECW file. Create with openEcw().
 * @param {BlobSource} blobSource
 * @param {object} header - parseHeader() result.
 * @param {Array} levels - parseLevels() result.
 * @param {Uint8Array} headerBytes - The header window, for the block index.
 */
export function EcwReader(blobSource, header, levels, headerBytes) {
	this._blobSource = blobSource;
	this._headerBytes = headerBytes;
	this._index = null;
	this._grid = null;
	this._header = header;
	this._levels = levels;
	this._closed = false;
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
 *   transparentBelow?:number, clipPolygon?:Array, onProgress?:function(number, string),
 *   signal?:AbortSignal, maxOutputBytes?:number}} opts
 *   x, y, width, height are full-resolution pixels; outWidth/outHeight default to width/height.
 * @returns {Promise<{data:Uint8ClampedArray, width:number, height:number, level:number,
 *   bounds:{minX:number, minY:number, maxX:number, maxY:number}}>}
 */
EcwReader.prototype.readRegion = async function (opts) {
	var o = opts || {};
	var h = this._header;
	// Step 1) Validate the request
	if (!Number.isInteger(o.x) || !Number.isInteger(o.y) || o.x < 0 || o.y < 0 || !isCount(o.width) || !isCount(o.height)) {
		throw invalid("readRegion needs integer x, y >= 0 and width, height > 0");
	}
	if (o.x + o.width > h.width || o.y + o.height > h.height) throw invalid("region runs past the image");
	var outW = o.outWidth === undefined ? o.width : o.outWidth;
	var outH = o.outHeight === undefined ? o.height : o.outHeight;
	if (!isCount(outW) || !isCount(outH)) throw invalid("outWidth and outHeight must be integers > 0");
	var maxBytes = o.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
	if (outW * outH * 4 > maxBytes) {
		throw new EcwError(ERROR_CODES.OUTPUT_TOO_LARGE, "output of " + outW + "x" + outH + " exceeds " + maxBytes + " bytes; use readRegionToScratch");
	}
	if (o.signal && o.signal.aborted) throw new EcwError(ERROR_CODES.ABORTED, "decode aborted");

	// Step 2) Choose the image level: coarsest one still at least as sharp as the output
	var factor = Math.min(o.width / outW, o.height / outH);
	var drop = factor >= 1 ? Math.min(h.levelCount, Math.floor(Math.log2(factor))) : 0;
	var level = h.levelCount - drop;
	var scale = Math.pow(2, drop);
	var size = imageLevelSize(h, this._levels, level);
	var lx0 = Math.floor(o.x / scale), ly0 = Math.floor(o.y / scale);
	var lx1 = Math.min(size.width, Math.ceil((o.x + o.width) / scale));
	var ly1 = Math.min(size.height, Math.ceil((o.y + o.height) / scale));

	// Step 3) Reconstruct the level window
	this._ensureIndex();
	var blobSource = this._blobSource;
	var index = this._index;
	var report = o.onProgress || function () {};
	var ctx = createDecodeContext({
		header: h, levels: this._levels, index: index, grid: this._grid, signal: o.signal,
		fetchBlock: async function (n) {
			var w = blockEntryWindow(index, n);
			var r = blockByteRange(index, n, await blobSource.read(w.start, w.end), blobSource.size);
			return blobSource.read(r.start, r.end);
		}
	});
	var total = countWindowBlocks(ctx, level, lx0, ly0, lx1, ly1);
	report(0, "reading " + total + " blocks");
	ctx.onBlock = function (done) { report(0.95 * done / total, "decoded " + done + " of " + total + " blocks"); };
	var win = await decodeWindow(ctx, level, lx0, ly0, lx1, ly1);

	// Step 4) Sample to the output grid (nearest level pixel to each output pixel centre)
	var winW = lx1 - lx0, winH = ly1 - ly0;
	var sampled = win.bands.map(function () { return new Float32Array(outW * outH); });
	for (var oy = 0; oy < outH; oy++) {
		var sy = Math.min(winH - 1, Math.max(0, Math.floor((o.y + (oy + 0.5) * o.height / outH) / scale) - ly0));
		for (var ox = 0; ox < outW; ox++) {
			var sx = Math.min(winW - 1, Math.max(0, Math.floor((o.x + (ox + 0.5) * o.width / outW) / scale) - lx0));
			for (var b = 0; b < sampled.length; b++) sampled[b][oy * outW + ox] = win.bands[b][sy * winW + sx];
		}
	}

	// Step 5) Colour and optional post-steps
	var data = new Uint8ClampedArray(outW * outH * 4);
	if (h.bands >= 3) yuvToRgba(sampled[0], sampled[1], sampled[2], data);
	else greyToRgba(sampled[0], data);
	var bounds = pixelWindowToBounds(this.info, o.x, o.y, o.width, o.height);
	if (o.transparentBelow !== undefined) applyTransparency(data, o.transparentBelow);
	if (o.clipPolygon) clipToPolygon(data, outW, outH, bounds, o.clipPolygon);
	report(1, "done");
	return { data: data, width: outW, height: outH, level: level, bounds: bounds };
};

/** Parse the block index lazily from the header window. */
EcwReader.prototype._ensureIndex = function () {
	if (this._index) return;
	this._index = parseBlockIndex(new MemorySource(this._headerBytes), this._header);
	this._grid = blockGrid(this._header, this._levels);
};

/** Decode a region into an OPFS scratch file. Not implemented until the codec lands. */
EcwReader.prototype.readRegionToScratch = async function () {
	throw new EcwError(ERROR_CODES.NOT_IMPLEMENTED, "pixel decoding is not implemented yet");
};

/** Release resources. Safe to call more than once. */
EcwReader.prototype.close = function () {
	this._closed = true;
};

/**
 * Open an ECW file and read its header, georeferencing and level table.
 * @param {Blob} blob - A File or Blob.
 * @returns {Promise<EcwReader>}
 */
export async function openEcw(blob) {
	var blobSource = new BlobSource(blob);
	var bytes = await blobSource.read(0, Math.min(HEADER_READ_BYTES, blobSource.size));
	var source = new MemorySource(bytes);
	var header = parseHeader(source);
	var levels = parseLevels(source, header);
	return new EcwReader(blobSource, header, levels, bytes);
}
