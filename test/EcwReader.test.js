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
		compressionTarget: 8, levels: [{ width: 125, height: 75 }, { width: 250, height: 150 }, { width: 500, height: 300 }, { width: 1000, height: 600 }],
		cellSizeX: 0.5, cellSizeY: -0.5, originX: 1000.25, originY: 5000.75, datum: "WGS84", projection: "LOCAL", units: null });
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
	assert.deepEqual(Object.keys(mod).sort(), ["BlobSource", "ERROR_CODES", "EcwError", "MemorySource", "SCRATCH_DIR", "STREAM_MODE", "VERSION",
		"applyTransparency", "blockByteRange", "blockEntryWindow", "blockGrid", "clipToPolygon", "decodeStream", "getScratchFile", "levelEntryWindow", "listScratchFiles", "openEcw",
		"openScratchReader", "openScratchSyncWriter",
		"parseBlockIndex", "parseHeader", "parseLevels", "pixelWindowToBounds", "removeScratchFile", "splitBlockStreams", "sweepStaleScratchFiles",
		"synthesizeWindow", "yuvToRgba"]);
});
