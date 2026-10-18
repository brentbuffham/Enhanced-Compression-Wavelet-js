// src/format/EcwLevels.js
//==========================================================
// ECW resolution-level table: `levelCount` records of 21 bytes
// from 0x59, coarsest first. Each record is u8 level index,
// u32 BE width, u32 BE height, then three u32 BE values a, b, c
// whose meaning is still open (FINDINGS.md "level table").
// Full resolution is not a record; it comes from the header.
// The ceil-halving rule is exported for tests and tools but not
// enforced, because only one encoder has been seen so far.
// Sizes may repeat at coarse levels (a 10 px high strip stays 1 px
// high for several levels), so the check is never-shrinking.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";
import { LEVEL_RECORD_LENGTH } from "./EcwHeader.js";

var HEADER_LEVEL_COUNT_OFFSET = 0x04;

/**
 * Byte offset just past the level table.
 * @param {object} header - parseHeader() result.
 * @returns {number}
 */
export function levelTableEnd(header) {
	return header.levelTableOffset + header.levelCount * LEVEL_RECORD_LENGTH;
}

/**
 * Level sizes predicted by ceil halving, coarsest first.
 * Level k of n is ceil(W / 2^(n-k)) x ceil(H / 2^(n-k)).
 * @returns {Array<{width:number,height:number}>}
 */
export function expectedLevelDimensions(width, height, count) {
	var list = [];
	for (var k = 0; k < count; k++) {
		var scale = Math.pow(2, count - k);
		list.push({ width: Math.ceil(width / scale), height: Math.ceil(height / scale) });
	}
	return list;
}

function bad(message, offset) {
	return new EcwError(ERROR_CODES.BAD_LEVEL_TABLE, message, offset);
}

/**
 * Parse the level table.
 * @param {object} source - Source contract holding the header and table.
 * @param {object} header - parseHeader() result.
 * @returns {Array<{level:number,width:number,height:number,a:number,b:number,c:number}>}
 */
export function parseLevels(source, header) {
	if (header.levelCount === 0) throw bad("level table is empty", HEADER_LEVEL_COUNT_OFFSET);
	var end = levelTableEnd(header);
	if (source.length() < end) {
		throw new EcwError(ERROR_CODES.TRUNCATED, "file ends inside the level table", end);
	}
	var levels = [];
	for (var i = 0; i < header.levelCount; i++) {
		var pos = header.levelTableOffset + i * LEVEL_RECORD_LENGTH;
		var record = {
			level: source.getUint8(pos),
			width: source.getUint32(pos + 1, false),
			height: source.getUint32(pos + 5, false),
			a: source.getUint32(pos + 9, false),
			b: source.getUint32(pos + 13, false),
			c: source.getUint32(pos + 17, false)
		};
		var prev = levels[i - 1];
		if (record.level !== i) throw bad("record " + i + " has level index " + record.level, pos);
		if (record.width === 0 || record.height === 0) throw bad("level " + i + " has zero size", pos);
		if (prev && (record.width < prev.width || record.height < prev.height)) {
			throw bad("level " + i + " is smaller than level " + (i - 1), pos);
		}
		if (record.width > header.width || record.height > header.height) {
			throw bad("level " + i + " is larger than the full image", pos);
		}
		levels.push(record);
	}
	return levels;
}
