// src/format/EcwHeader.js
//==========================================================
// ECW v2 fixed header and georeferencing.
// Layout worked out from file bytes and checked against GDAL;
// see _dev/ecw-decode/FINDINGS.md "fixed header".
// ⚠️ Mixed endianness: integers big-endian, doubles little-endian.
// Byte 0x03 is the colour space (meanings named by the ECW SDK through
// GDAL). Unknown bytes (0x02, 0x05, 0x10) are skipped, not guessed.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";
import { readAscii } from "../io/ByteSource.js";

/** First byte of every ECW file seen so far. */
export var ECW_SIGNATURE = 0x65;
/** Bytes before the level table. */
export var HEADER_FIXED_LENGTH = 0x59;
/**
 * Bytes per level-table record: index, width, height, one step per band.
 * @param {number} bands
 * @returns {number}
 */
export function levelRecordLength(bands) {
	return 9 + 4 * bands;
}

// Byte 0x03 values; only "yuv" carries luma/chroma bands needing colour conversion
var COLOR_SPACES = ["none", "greyscale", "yuv", "multiband", "rgb", "ycbcr"];

var SUPPORTED_VERSION = 2;
var NAME_LENGTH = 16;

var HEADER_SIGNATURE_OFFSET = 0x00;
var HEADER_VERSION_OFFSET = 0x01;
var HEADER_COLOR_SPACE_OFFSET = 0x03;
var HEADER_LEVEL_COUNT_OFFSET = 0x04;
var HEADER_WIDTH_OFFSET = 0x06;
var HEADER_HEIGHT_OFFSET = 0x0A;
var HEADER_BANDS_OFFSET = 0x0E;
var HEADER_BLOCK_WIDTH_OFFSET = 0x12;
var HEADER_BLOCK_HEIGHT_OFFSET = 0x14;
var HEADER_COMPRESSION_OFFSET = 0x16;
var HEADER_GEOREF_FLAG_OFFSET = 0x18;
var HEADER_CELL_X_OFFSET = 0x19;
var HEADER_CELL_Y_OFFSET = 0x21;
var HEADER_ORIGIN_X_OFFSET = 0x29;
var HEADER_ORIGIN_Y_OFFSET = 0x31;
var HEADER_DATUM_OFFSET = 0x39;
var HEADER_PROJECTION_OFFSET = 0x49;

function requirePositive(value, offset, name) {
	if (value === 0) throw new EcwError(ERROR_CODES.NOT_ECW, name + " is zero", offset);
	return value;
}

/**
 * Parse the fixed ECW header.
 * @param {object} source - Source contract holding at least the first 0x59 bytes.
 * @returns {{version:number, levelCount:number, width:number, height:number, bands:number,
 *   blockWidth:number, blockHeight:number, compressionTarget:number, hasGeoreference:boolean,
 *   cellSizeX:number, cellSizeY:number, originX:number, originY:number,
 *   datum:string, projection:string, units:null, levelTableOffset:number,
 *   colorSpace:string, levelRecordLength:number}}
 *   colorSpace: "none", "greyscale", "yuv", "multiband", "rgb", "ycbcr" or "unknown".
 */
export function parseHeader(source) {
	// Step 1) Enough bytes for the fixed part
	if (source.length() < HEADER_FIXED_LENGTH) {
		throw new EcwError(ERROR_CODES.TRUNCATED, "file shorter than the ECW header", HEADER_FIXED_LENGTH);
	}
	// Step 2) Signature and version
	if (source.getUint8(HEADER_SIGNATURE_OFFSET) !== ECW_SIGNATURE) {
		throw new EcwError(ERROR_CODES.NOT_ECW, "missing ECW signature byte 0x65", HEADER_SIGNATURE_OFFSET);
	}
	var version = source.getUint8(HEADER_VERSION_OFFSET);
	if (version !== SUPPORTED_VERSION) {
		throw new EcwError(ERROR_CODES.UNSUPPORTED_VERSION, "ECW version " + version + " is not supported", HEADER_VERSION_OFFSET);
	}
	// Step 3) Dimensions and layout
	return {
		version: version,
		levelCount: source.getUint8(HEADER_LEVEL_COUNT_OFFSET),
		width: requirePositive(source.getUint32(HEADER_WIDTH_OFFSET, false), HEADER_WIDTH_OFFSET, "width"),
		height: requirePositive(source.getUint32(HEADER_HEIGHT_OFFSET, false), HEADER_HEIGHT_OFFSET, "height"),
		bands: requirePositive(source.getUint16(HEADER_BANDS_OFFSET, false), HEADER_BANDS_OFFSET, "band count"),
		blockWidth: source.getUint16(HEADER_BLOCK_WIDTH_OFFSET, false),
		blockHeight: source.getUint16(HEADER_BLOCK_HEIGHT_OFFSET, false),
		compressionTarget: source.getUint16(HEADER_COMPRESSION_OFFSET, false),
		// Step 4) Georeferencing
		hasGeoreference: source.getUint8(HEADER_GEOREF_FLAG_OFFSET) === 1,
		cellSizeX: source.getFloat64(HEADER_CELL_X_OFFSET, true),
		cellSizeY: source.getFloat64(HEADER_CELL_Y_OFFSET, true),
		originX: source.getFloat64(HEADER_ORIGIN_X_OFFSET, true),
		originY: source.getFloat64(HEADER_ORIGIN_Y_OFFSET, true),
		datum: readAscii(source, HEADER_DATUM_OFFSET, NAME_LENGTH),
		projection: readAscii(source, HEADER_PROJECTION_OFFSET, NAME_LENGTH),
		units: null,
		levelTableOffset: HEADER_FIXED_LENGTH,
		colorSpace: COLOR_SPACES[source.getUint8(HEADER_COLOR_SPACE_OFFSET)] || "unknown",
		levelRecordLength: levelRecordLength(source.getUint16(HEADER_BANDS_OFFSET, false))
	};
}
