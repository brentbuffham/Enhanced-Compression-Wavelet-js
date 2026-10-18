// src/format/EcwBlockIndex.js
//==========================================================
// ECW block index (FINDINGS.md "block index"). Right after the
// level table, at E = 0x59 + 21 x levelCount:
//   E      u32 BE  body length L, counted from E + 4
//   E + 4  u8      flag (always 1 so far; meaning open)
//   E + 5  u64 LE  (L - 1) / 8 offsets, relative to dataStart = E + 4 + L
// One entry per 64x64 block of every level record (level-major,
// coarsest first, row-major within a level) plus an end marker.
// ⚠️ The index can be hundreds of MB: callers read 16-byte entry
// windows (or one level's window), never the whole index.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";
import { readU64 } from "../io/ByteSource.js";
import { MemorySource } from "../io/MemorySource.js";
import { levelTableEnd } from "./EcwLevels.js";

var ENTRY_LENGTH = 8;
var HEADER_BLOCK_WIDTH_OFFSET = 0x12;
var HEADER_BLOCK_HEIGHT_OFFSET = 0x14;

function badIndex(message, offset) {
	return new EcwError(ERROR_CODES.BAD_BLOCK_INDEX, message, offset);
}

/**
 * Parse the block index header. Needs only the bytes up to E + 5.
 * @param {object} source - Source contract.
 * @param {object} header - parseHeader() result.
 * @returns {{indexOffset:number, bodyLength:number, flag:number, entryCount:number,
 *   offsetsStart:number, dataStart:number}}
 */
export function parseBlockIndex(source, header) {
	var indexOffset = levelTableEnd(header);
	if (source.length() < indexOffset + 5) {
		throw new EcwError(ERROR_CODES.TRUNCATED, "file ends inside the block index header", indexOffset + 5);
	}
	var bodyLength = source.getUint32(indexOffset, false);
	if (bodyLength < 1 + ENTRY_LENGTH || (bodyLength - 1) % ENTRY_LENGTH !== 0) {
		throw badIndex("block index length " + bodyLength + " is not 1 + 8k", indexOffset);
	}
	return {
		indexOffset: indexOffset,
		bodyLength: bodyLength,
		flag: source.getUint8(indexOffset + 4),
		entryCount: (bodyLength - 1) / ENTRY_LENGTH,
		offsetsStart: indexOffset + 5,
		dataStart: indexOffset + 4 + bodyLength
	};
}

/**
 * Block grid of each level record.
 * @param {object} header - parseHeader() result.
 * @param {Array<{level:number,width:number,height:number}>} levels - parseLevels() result.
 * @returns {Array<{level:number, cols:number, rows:number, firstBlock:number}>}
 */
export function blockGrid(header, levels) {
	if (header.blockWidth === 0) throw badIndex("block width is zero", HEADER_BLOCK_WIDTH_OFFSET);
	if (header.blockHeight === 0) throw badIndex("block height is zero", HEADER_BLOCK_HEIGHT_OFFSET);
	var first = 0;
	return levels.map(function (lv) {
		var entry = {
			level: lv.level,
			cols: Math.ceil(lv.width / header.blockWidth),
			rows: Math.ceil(lv.height / header.blockHeight),
			firstBlock: first
		};
		first += entry.cols * entry.rows;
		return entry;
	});
}

/** @returns {number} total blocks across all levels */
export function totalBlocks(grid) {
	var last = grid[grid.length - 1];
	return last ? last.firstBlock + last.cols * last.rows : 0;
}

/**
 * Block number of (level, row, col).
 * @returns {number}
 */
export function blockNumber(grid, level, row, col) {
	var g = grid[level];
	if (!g || row < 0 || row >= g.rows || col < 0 || col >= g.cols) {
		throw new EcwError(ERROR_CODES.INVALID_ARGUMENT, "no block at level " + level + " row " + row + " col " + col);
	}
	return g.firstBlock + row * g.cols + col;
}

/**
 * File byte range of the two index entries bounding block n.
 * @returns {{start:number, end:number}}
 */
export function blockEntryWindow(index, n) {
	if (!Number.isInteger(n) || n < 0 || n >= index.entryCount - 1) {
		throw new EcwError(ERROR_CODES.INVALID_ARGUMENT, "block " + n + " is outside the index");
	}
	var start = index.offsetsStart + n * ENTRY_LENGTH;
	return { start: start, end: start + 2 * ENTRY_LENGTH };
}

/**
 * File byte range of all entries for one level, plus the entry after it.
 * @param {object} index - parseBlockIndex() result.
 * @param {{firstBlock:number, cols:number, rows:number}} gridLevel - One blockGrid() entry.
 * @returns {{start:number, end:number}}
 */
export function levelEntryWindow(index, gridLevel) {
	var start = index.offsetsStart + gridLevel.firstBlock * ENTRY_LENGTH;
	return { start: start, end: start + (gridLevel.cols * gridLevel.rows + 1) * ENTRY_LENGTH };
}

/**
 * File byte range of block n from its two index entries.
 * @param {object} index - parseBlockIndex() result.
 * @param {number} n - Block number.
 * @param {Uint8Array} entryBytes - The 16 bytes at blockEntryWindow(index, n).
 * @param {number} fileSize
 * @returns {{start:number, end:number}}
 */
export function blockByteRange(index, n, entryBytes, fileSize) {
	var entryPos = index.offsetsStart + n * ENTRY_LENGTH;
	var source = new MemorySource(entryBytes);
	var a = readU64(source, 0, true);
	var b = readU64(source, ENTRY_LENGTH, true);
	if (a === null) throw badIndex("block offset too large", entryPos);
	if (b === null) throw badIndex("block offset too large", entryPos + ENTRY_LENGTH);
	if (b < a) throw badIndex("block offsets fall", entryPos + ENTRY_LENGTH);
	var end = index.dataStart + b;
	if (end > fileSize) throw new EcwError(ERROR_CODES.TRUNCATED, "block " + n + " ends past the file", end);
	return { start: index.dataStart + a, end: end };
}

/**
 * Check the entry count against the level grid (blocks + 1 end marker).
 */
export function checkBlockIndex(index, grid) {
	var expected = totalBlocks(grid) + 1;
	if (index.entryCount !== expected) {
		throw badIndex("block index has " + index.entryCount + " entries, level grid needs " + expected, index.indexOffset);
	}
}
