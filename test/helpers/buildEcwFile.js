// test/helpers/buildEcwFile.js
//==========================================================
// Builds a synthetic ECW file: header + level table (from
// buildEcwHeader), block index (u32 BE body length, flag byte,
// u64 LE offsets relative to the data start, end marker), then
// the block bytes. Layout per FINDINGS.md "block index". Test-only.
//==========================================================

import { buildEcwHeader } from "./buildEcwHeader.js";

/**
 * @param {{headerOverrides?: object, blocks?: Uint8Array[], entries?: number[],
 *   bodyLength?: number, flag?: number, truncateAt?: number}} o
 *   `entries` replaces the computed offsets (for corrupt-index tests).
 * @returns {Uint8Array}
 */
export function buildEcwFile(o) {
	var header = buildEcwHeader(o.headerOverrides || {});
	var blocks = o.blocks || [];
	var entries = o.entries;
	if (!entries) {
		entries = [0];
		blocks.forEach(function (b) { entries.push(entries[entries.length - 1] + b.length); });
	}
	var bodyLength = typeof o.bodyLength === "number" ? o.bodyLength : 1 + 8 * entries.length;
	var dataLength = blocks.reduce(function (sum, b) { return sum + b.length; }, 0);
	var out = new Uint8Array(header.length + 5 + 8 * entries.length + dataLength);
	var view = new DataView(out.buffer);
	out.set(header, 0);
	var pos = header.length;
	view.setUint32(pos, bodyLength, false);
	out[pos + 4] = typeof o.flag === "number" ? o.flag : 1;
	pos += 5;
	entries.forEach(function (e) {
		view.setUint32(pos, e % 4294967296, true);
		view.setUint32(pos + 4, Math.floor(e / 4294967296), true);
		pos += 8;
	});
	blocks.forEach(function (b) { out.set(b, pos); pos += b.length; });
	return typeof o.truncateAt === "number" ? out.slice(0, o.truncateAt) : out;
}

/** n blocks of distinct lengths 1..n, each filled with its own index. */
export function numberedBlocks(n) {
	return Array.from({ length: n }, function (_, i) { return new Uint8Array(i + 1).fill(i & 0xFF); });
}
