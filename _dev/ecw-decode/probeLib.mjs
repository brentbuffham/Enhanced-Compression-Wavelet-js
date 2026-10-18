// _dev/ecw-decode/probeLib.mjs
//==========================================================
// Pure helpers for the ECW reverse-engineering probes
// (hexAnnotate.mjs, byteStats.mjs). Dev-only, not shipped.
// Findings go in FINDINGS.md beside this file.
//==========================================================

/**
 * Parse a CLI number, decimal or 0x hex.
 * @param {string} text
 * @returns {number}
 */
export function parseNumberArg(text) {
	var value = /^0x[0-9a-f]+$/i.test(text) ? parseInt(text, 16) : /^\d+$/.test(text) ? parseInt(text, 10) : NaN;
	if (!Number.isFinite(value)) throw new Error("not a number: " + text);
	return value;
}

/**
 * Format bytes as annotated hex rows of 16.
 * Row: "0x%08x: <hex>  <ascii>" plus "  ; label, label" for annotations starting in that row.
 * @param {Uint8Array} bytes
 * @param {number} baseOffset - File offset of bytes[0].
 * @param {Array<{offset:number,length:number,label:string}>} annotations
 * @returns {string[]}
 */
export function formatHexRows(bytes, baseOffset, annotations) {
	var rows = [];
	for (var i = 0; i < bytes.length; i += 16) {
		var rowStart = baseOffset + i;
		var hex = [];
		var text = "";
		for (var j = 0; j < 16; j++) {
			if (i + j < bytes.length) {
				var b = bytes[i + j];
				hex.push(b.toString(16).padStart(2, "0"));
				text += b >= 0x20 && b <= 0x7E ? String.fromCharCode(b) : ".";
			} else {
				hex.push("  ");
			}
		}
		var row = "0x" + rowStart.toString(16).padStart(8, "0") + ": " + hex.join(" ") + "  " + text;
		var labels = (annotations || []).filter(function (a) {
			return a.offset >= rowStart && a.offset < rowStart + 16;
		}).map(function (a) { return a.label; });
		if (labels.length) row += "  ; " + labels.join(", ");
		rows.push(row);
	}
	return rows;
}

/**
 * Shannon entropy in bits per byte (0 to 8).
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function shannonEntropy(bytes) {
	if (bytes.length === 0) return 0;
	var counts = new Array(256).fill(0);
	for (var i = 0; i < bytes.length; i++) counts[bytes[i]]++;
	var bits = 0;
	for (var v = 0; v < 256; v++) {
		if (counts[v] === 0) continue;
		var p = counts[v] / bytes.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

/**
 * Most frequent byte values, by count desc then value asc.
 * @param {Uint8Array} bytes
 * @param {number} n
 * @returns {Array<{value:number,count:number}>}
 */
export function histogramTop(bytes, n) {
	var counts = new Array(256).fill(0);
	for (var i = 0; i < bytes.length; i++) counts[bytes[i]]++;
	var list = [];
	for (var v = 0; v < 256; v++) if (counts[v]) list.push({ value: v, count: counts[v] });
	list.sort(function (a, b) { return b.count - a.count || a.value - b.value; });
	return list.slice(0, n);
}

/**
 * Read [start, start + length) of a file without loading the rest.
 * @param {typeof import("node:fs")} fs
 * @returns {Uint8Array}
 */
export function readFileRange(fs, path, start, length) {
	var fd = fs.openSync(path, "r");
	try {
		var size = fs.fstatSync(fd).size;
		var count = Math.max(0, Math.min(length, size - start));
		var buf = new Uint8Array(count);
		fs.readSync(fd, buf, 0, count, start);
		return buf;
	} finally {
		fs.closeSync(fd);
	}
}
