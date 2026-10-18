// src/EcwReader.js
//==========================================================
// Thin reader over a File/Blob. Reads one header window with
// BlobSource, parses it through MemorySource, and exposes `info`.
// Pixel reads (readRegion / readRegionToScratch) arrive with the
// codec in Plan 2; until then they reject NOT_IMPLEMENTED.
//==========================================================

import { EcwError, ERROR_CODES } from "./errors.js";
import { BlobSource } from "./io/BlobSource.js";
import { MemorySource } from "./io/MemorySource.js";
import { parseHeader } from "./format/EcwHeader.js";
import { parseLevels } from "./format/EcwLevels.js";

// Fixed header (0x59) plus up to 255 level records (21 bytes each) fits in 8 KB
var HEADER_READ_BYTES = 8192;

/**
 * Reader for one ECW file. Create with openEcw().
 * @param {BlobSource} blobSource
 * @param {object} header - parseHeader() result.
 * @param {Array} levels - parseLevels() result.
 */
export function EcwReader(blobSource, header, levels) {
	this._blobSource = blobSource;
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

/** Decode a region to RGBA. Not implemented until the codec lands. */
EcwReader.prototype.readRegion = async function () {
	throw new EcwError(ERROR_CODES.NOT_IMPLEMENTED, "pixel decoding is not implemented yet");
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
	return new EcwReader(blobSource, header, levels);
}
