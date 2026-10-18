// test/helpers/samples.js
//==========================================================
// Locates the private sample and its GDAL reference set in the
// gitignored samples/ folder. Test-only.
//==========================================================

import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

var SAMPLES_DIR = fileURLToPath(new URL("../../samples/", import.meta.url));

/**
 * First samples/*.ecw plus samples/ref/, or null when either is missing.
 * @returns {{ecwPath:string, refDir:string}|null}
 */
export function findSample() {
	if (!fs.existsSync(SAMPLES_DIR)) return null;
	var ecw = fs.readdirSync(SAMPLES_DIR).filter(function (n) { return /\.ecw$/i.test(n); }).sort()[0];
	var refDir = join(SAMPLES_DIR, "ref");
	if (!ecw || !fs.existsSync(join(refDir, "gdalinfo.json"))) return null;
	return { ecwPath: join(SAMPLES_DIR, ecw), refDir: refDir };
}

/**
 * Read [start, start + length) of a file, clipped to its size.
 * @returns {Uint8Array}
 */
export function readRange(path, start, length) {
	var fd = fs.openSync(path, "r");
	try {
		var count = Math.max(0, Math.min(length, fs.fstatSync(fd).size - start));
		var buf = new Uint8Array(count);
		fs.readSync(fd, buf, 0, count, start);
		return buf;
	} finally {
		fs.closeSync(fd);
	}
}
