// src/format/EcwLevels.js
//==========================================================
// ECW resolution-level table: `levelCount` records from 0x59,
// coarsest first. Each record is u8 level index, u32 BE width,
// u32 BE height, then one u32 BE dequantisation step per band, so a
// record is 9 + 4 x bands bytes (21 for RGB). FINDINGS.md "level table".
// Full resolution is not a record; it comes from the header.
// The ceil-halving rule is exported for tests and tools but not
// enforced, because only one encoder has been seen so far.
// Sizes may repeat at coarse levels (a 10 px high strip stays 1 px
// high for several levels), so the check is never-shrinking.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";
import { levelRecordLength } from "./EcwHeader.js";

var HEADER_LEVEL_COUNT_OFFSET = 0x04;

/**
 * Byte offset just past the level table.
 * @param {object} header - parseHeader() result.
 * @returns {number}
 */
export function levelTableEnd(header) {
	return header.levelTableOffset + header.levelCount * levelRecordLength(header.bands);
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
 * @returns {Array<{level:number,width:number,height:number,steps:number[],a:number,b:number,c:number}>}
 *   steps holds one step per band; a, b, c are steps[0..2] (undefined past the band count).
 */
export function parseLevels(source, header) {
	if (header.levelCount === 0) throw bad("level table is empty", HEADER_LEVEL_COUNT_OFFSET);
	var end = levelTableEnd(header);
	if (source.length() < end) {
		throw new EcwError(ERROR_CODES.TRUNCATED, "file ends inside the level table", end);
	}
	var levels = [];
	for (var i = 0; i < header.levelCount; i++) {
		var pos = header.levelTableOffset + i * levelRecordLength(header.bands);
		var steps = [];
		for (var b = 0; b < header.bands; b++) steps.push(source.getUint32(pos + 9 + 4 * b, false));
		var record = {
			level: source.getUint8(pos),
			width: source.getUint32(pos + 1, false),
			height: source.getUint32(pos + 5, false),
			steps: steps,
			a: steps[0],
			b: steps[1],
			c: steps[2]
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
