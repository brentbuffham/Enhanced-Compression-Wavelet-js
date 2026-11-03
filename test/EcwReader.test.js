// test/EcwReader.test.js
//==========================================================
// openEcw: header-only reader over a File/Blob, public exports.
// Run with: node --test test/EcwReader.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openEcw } from "../src/EcwReader.js";
import { buildEcwHeader } from "./helpers/buildEcwHeader.js";

test("openEcw exposes info from a synthetic header", async function () {
	var r = await openEcw(new Blob([buildEcwHeader({})]));
	assert.deepEqual(r.info, { version: 2, width: 1000, height: 600, bands: 3, blockWidth: 64, blockHeight: 64,
		compressionTarget: 8, colorSpace: "yuv", levels: [{ width: 125, height: 75 }, { width: 250, height: 150 }, { width: 500, height: 300 }, { width: 1000, height: 600 }],
		cellSizeX: 0.5, cellSizeY: -0.5, originX: 1000.25, originY: 5000.75, datum: "WGS84", projection: "LOCAL", units: null });
});

// Matches buildEcwHeader's defaults: 0.5 m cells, corner 1000.25, 5000.75
var WORLD = "0.5\n0\n0\n-0.5\n1000.5\n5000.5\n";
var PRJ = "PROJCS[\"Test grid\",GEOGCS[\"g\",DATUM[\"D_Test\",SPHEROID[\"s\",6378137,298.257]]],PROJECTION[\"Transverse_Mercator\"],UNIT[\"Meter\",1]]";

test("openEcw without sidecars leaves info as the header gives it", async function () {
	var r = await openEcw(new Blob([buildEcwHeader({})]), {});
	assert.equal("crs" in r.info, false);
	assert.equal("worldFile" in r.info, false);
});

test("openEcw with a matching world file and prj (text or Blob)", async function () {
	var r = await openEcw(new Blob([buildEcwHeader({})]), { worldFile: new Blob([WORLD]), prj: PRJ });
	assert.equal(r.info.georefSource, "header");
	assert.deepEqual(r.info.warnings, []);
	assert.equal(r.info.originX, 1000.25);
	assert.equal(r.info.worldFile.centreX, 1000.5);
	assert.equal(r.info.worldFile.originY, 5000.75);
	assert.equal(r.info.crs.name, "Test grid");
	assert.equal(r.info.crs.wkt, PRJ);
	assert.equal(r.info.units, "Meter");
	assert.equal(r.info.datum, "WGS84");
});

test("openEcw warns when the world file disagrees, and georef worldFile uses it", async function () {
	var off = "0.25\n0\n0\n-0.25\n2000.125\n6000.125\n";
	var r = await openEcw(new Blob([buildEcwHeader({})]), { worldFile: off });
	assert.equal(r.info.warnings.length, 4);
	assert.match(r.info.warnings[0], /cell size X 0.25 differs from the header's 0.5/);
	assert.match(r.info.warnings[2], /origin X differs from the header's by 999.75 \(1999.5 cells\)/);
	assert.equal(r.info.originX, 1000.25);
	assert.equal(r.info.units, null);
	var w = await openEcw(new Blob([buildEcwHeader({})]), { worldFile: off, georef: "worldFile" });
	assert.equal(w.info.georefSource, "worldFile");
	assert.equal(w.info.originX, 2000);
	assert.equal(w.info.originY, 6000.25);
	assert.equal(w.info.cellSizeX, 0.25);
	assert.equal(w.info.crs, null);
});

test("openEcw: rotated world files warn, or reject when used", async function () {
	var rot = "0.5\n0.1\n0\n-0.5\n1000.5\n5000.5\n";
	var r = await openEcw(new Blob([buildEcwHeader({})]), { worldFile: rot });
	assert.match(r.info.warnings.join("\n"), /rotated/);
	await assert.rejects(openEcw(new Blob([buildEcwHeader({})]), { worldFile: rot, georef: "worldFile" }), { code: "NOT_IMPLEMENTED" });
});

test("openEcw rejects bad sidecar options", async function () {
	var blob = new Blob([buildEcwHeader({})]);
	await assert.rejects(openEcw(blob, { georef: "prj" }), { code: "INVALID_ARGUMENT", message: /georef must be/ });
	await assert.rejects(openEcw(blob, { georef: "worldFile" }), { code: "INVALID_ARGUMENT", message: /needs a worldFile/ });
	await assert.rejects(openEcw(blob, { worldFile: 12 }), { code: "INVALID_ARGUMENT", message: /worldFile must be/ });
	await assert.rejects(openEcw(blob, { prj: "nonsense" }), { code: "INVALID_ARGUMENT", message: /prj is not valid WKT/ });
});

test("openEcw reads only the header window of a large blob", async function () {
	var header = buildEcwHeader({});
	var big = new Blob([header, new Uint8Array(1024 * 1024)]);
	var r = await openEcw(big);
	assert.equal(r.info.width, 1000);
});

test("openEcw on a PNG rejects NOT_ECW", async function () {
	var png = new Uint8Array(104); png.set([0x89, 0x50, 0x4E, 0x47]);
	await assert.rejects(openEcw(new Blob([png])), { code: "NOT_ECW", offset: 0 });
});

test("openEcw on an 8-byte blob rejects TRUNCATED", async function () {
	await assert.rejects(openEcw(new Blob([buildEcwHeader({ truncateAt: 8 })])), { code: "TRUNCATED" });
});

test("openEcw with a non-Blob rejects INVALID_ARGUMENT", async function () {
	await assert.rejects(openEcw("file.ecw"), { code: "INVALID_ARGUMENT" });
});

test("close is idempotent", async function () {
	var r = await openEcw(new Blob([buildEcwHeader({})]));
	await r.close();
	await r.close();
});

test("public exports", async function () {
	var mod = await import("../src/index.js");
	assert.deepEqual(Object.keys(mod).sort(), ["BlobSource", "BlockCache", "CACHE_DIR", "ERROR_CODES", "EcwError", "MemorySource", "SCRATCH_DIR", "STREAM_MODE", "VERSION",
		"applyColorKey", "applyStretch", "applyTransparency", "blockByteRange", "blockCacheUsage", "blockEntryWindow", "blockGrid", "clearBlockCache", "clipToPolygon", "decodeStream", "fileFingerprint", "getScratchFile", "levelEntryWindow", "listScratchFiles", "openEcw",
		"openScratchReader", "openScratchSyncWriter",
		"parseBlockIndex", "parseHeader", "parseLevels", "parsePrj", "parseWorldFile", "pickSidecars", "pixelWindowToBounds", "removeScratchFile", "splitBlockStreams", "stretchFromPixels", "sweepStaleScratchFiles",
		"synthesizeWindow", "yuvToRgba"]);
});
