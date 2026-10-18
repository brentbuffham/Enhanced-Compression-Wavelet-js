// examples/browser/lib/demoCore.js
//==========================================================
// The demo's worker logic, kept DOM-free so Node tests can run it.
// Every read goes through BlobSource ranges: the header window,
// one level's slice of the block index, or a single block. The
// whole file and the whole index are never loaded.
//==========================================================

import { openEcw, BlobSource, MemorySource, parseHeader, parseLevels, parseBlockIndex, blockGrid,
	blockEntryWindow, levelEntryWindow, blockByteRange, splitBlockStreams, pixelWindowToBounds } from "../../../src/index.js";
import { checkBlockIndex, totalBlocks } from "../../../src/format/EcwBlockIndex.js";
import { readU64 } from "../../../src/io/ByteSource.js";

var HEADER_READ_BYTES = 8192;

/**
 * Open a file: info, header, levels, block index and grid.
 * @param {Blob} blob
 * @param {function(number, string)} onProgress
 */
export async function openFile(blob, onProgress) {
	onProgress(0, "reading header");
	var reader = await openEcw(blob);
	var bytes = await new BlobSource(blob).read(0, Math.min(HEADER_READ_BYTES, blob.size));
	var source = new MemorySource(bytes);
	var header = parseHeader(source);
	var levels = parseLevels(source, header);
	var index = parseBlockIndex(source, header);
	var grid = blockGrid(header, levels);
	checkBlockIndex(index, grid);
	onProgress(1, "header and block index read");
	return {
		info: reader.info,
		header: header,
		levels: levels,
		index: index,
		grid: grid,
		fileSize: blob.size,
		stats: {
			compressionRatio: header.width * header.height * header.bands / blob.size,
			blockCount: totalBlocks(grid)
		}
	};
}

/**
 * Byte length of every block in one level, from one read of its index slice.
 * @returns {Promise<{cols:number, rows:number, sizes:Uint32Array}>}
 */
export async function readLevelBlockSizes(blob, index, grid, level, onProgress) {
	var g = grid[level];
	var window = levelEntryWindow(index, g);
	onProgress(0, "reading level " + level + " index");
	var source = new MemorySource(await new BlobSource(blob).read(window.start, window.end));
	var count = g.cols * g.rows;
	var sizes = new Uint32Array(count);
	var prev = readU64(source, 0, true);
	for (var i = 0; i < count; i++) {
		var next = readU64(source, (i + 1) * 8, true);
		sizes[i] = next - prev;
		prev = next;
	}
	onProgress(1, "level " + level + ": " + count + " blocks");
	return { cols: g.cols, rows: g.rows, sizes: sizes };
}

function levelOfBlock(grid, n) {
	for (var i = 0; i < grid.length; i++) {
		if (n < grid[i].firstBlock + grid[i].cols * grid[i].rows) return i;
	}
	return -1;
}

/**
 * Read and frame one block.
 * @returns {Promise<{n, level, row, col, start, end, streams: Array<{band, subband, mode, length}>}>}
 */
export async function inspectBlock(blob, index, grid, info, n) {
	var source = new BlobSource(blob);
	var window = blockEntryWindow(index, n);
	var range = blockByteRange(index, n, await source.read(window.start, window.end), blob.size);
	var level = levelOfBlock(grid, n);
	var g = grid[level];
	var local = n - g.firstBlock;
	var streams = splitBlockStreams(await source.read(range.start, range.end), info.bands, level);
	return {
		n: n,
		level: level,
		row: Math.floor(local / g.cols),
		col: local % g.cols,
		start: range.start,
		end: range.end,
		streams: streams.map(function (s) {
			return { band: s.band, subband: s.subband, mode: s.mode, length: s.bytes.length + 1 };
		})
	};
}

/**
 * Tally stream modes over evenly spaced blocks of one level.
 * @returns {Promise<{sampled:number, modes:{2:number, 5:number, 6:number}, emptyShare:number}>}
 */
export async function sampleModes(blob, index, grid, info, level, count, onProgress) {
	var g = grid[level];
	var blocks = g.cols * g.rows;
	var sampled = Math.min(count, blocks);
	var modes = { 2: 0, 5: 0, 6: 0 };
	var streams = 0;
	for (var i = 0; i < sampled; i++) {
		var n = g.firstBlock + Math.floor(i * blocks / sampled);
		var block = await inspectBlock(blob, index, grid, info, n);
		block.streams.forEach(function (s) { modes[s.mode]++; streams++; });
		if (i % 16 === 0) onProgress(i / sampled, "sampling level " + level);
	}
	onProgress(1, "sampled " + sampled + " blocks");
	return { sampled: sampled, modes: modes, emptyShare: streams ? modes[5] / streams : 0 };
}

/**
 * Map bounds of a level's block map (whole blocks, so it can overhang the image).
 * @returns {{minX, minY, maxX, maxY}}
 */
export function levelPictureBounds(info, header, gridLevel) {
	var scale = Math.pow(2, header.levelCount - gridLevel.level);
	return pixelWindowToBounds(info, 0, 0, gridLevel.cols * header.blockWidth * scale, gridLevel.rows * header.blockHeight * scale);
}
