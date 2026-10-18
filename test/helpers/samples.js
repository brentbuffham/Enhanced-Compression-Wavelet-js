// test/helpers/samples.js
//==========================================================
// Locates the private samples and their GDAL reference sets in the
// gitignored samples/ folder: samples/*.ecw with samples/ref/ (id "a"),
// and samples/<id>/*.ecw with samples/<id>/ref/. Test-only.
//==========================================================

import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

var SAMPLES_DIR = fileURLToPath(new URL("../../samples/", import.meta.url));

// The sample in dir (first *.ecw with ref/gdalinfo.json beside it), or null
function sampleIn(dir, id) {
	var ecw = fs.readdirSync(dir).filter(function (n) { return /\.ecw$/i.test(n); }).sort()[0];
	var refDir = join(dir, "ref");
	if (!ecw || !fs.existsSync(join(refDir, "gdalinfo.json"))) return null;
	return { id: id, ecwPath: join(dir, ecw), refDir: refDir };
}

/**
 * Every private sample with a reference set. Ids, never file names, identify them.
 * @returns {Array<{id:string, ecwPath:string, refDir:string}>}
 */
export function findSamples() {
	if (!fs.existsSync(SAMPLES_DIR)) return [];
	var list = [];
	var root = sampleIn(SAMPLES_DIR, "a");
	if (root) list.push(root);
	fs.readdirSync(SAMPLES_DIR, { withFileTypes: true }).filter(function (d) {
		return d.isDirectory() && d.name !== "ref" && d.name !== "synth";
	}).map(function (d) { return d.name; }).sort().forEach(function (name) {
		var s = sampleIn(join(SAMPLES_DIR, name), name);
		if (s) list.push(s);
	});
	return list;
}

/**
 * First sample (probes and single-sample tools), or null.
 * @returns {{id:string, ecwPath:string, refDir:string}|null}
 */
export function findSample() {
	return findSamples()[0] || null;
}

/**
 * Run fn(sample, label, skip) once per sample, or once with sample null and a
 * skip reason when there are none. label is " (sample <id>)" for test names.
 * @param {function(object|null, string, string|false)} fn
 */
export function forEachSample(fn) {
	var list = findSamples();
	if (!list.length) {
		fn(null, "", "no samples/*.ecw with ref/gdalinfo.json");
		return;
	}
	list.forEach(function (s) { fn(s, " (sample " + s.id + ")", false); });
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
