// test/format/EcwHeader.test.js
//==========================================================
// parseHeader: fixed header and georeferencing (spec §7).
// Run with: node --test test/format/EcwHeader.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHeader, HEADER_FIXED_LENGTH, LEVEL_RECORD_LENGTH, ECW_SIGNATURE } from "../../src/format/EcwHeader.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { buildEcwHeader } from "../helpers/buildEcwHeader.js";

function parse(overrides) { return parseHeader(new MemorySource(buildEcwHeader(overrides))); }

test("constants", function () {
	assert.equal(HEADER_FIXED_LENGTH, 0x59);
	assert.equal(LEVEL_RECORD_LENGTH, 21);
	assert.equal(ECW_SIGNATURE, 0x65);
});

test("parses every field of a synthetic header", function () {
	assert.deepEqual(parse({}), { version: 2, levelCount: 3, width: 1000, height: 600, bands: 3, blockWidth: 64, blockHeight: 64,
		compressionTarget: 8, hasGeoreference: true, cellSizeX: 0.5, cellSizeY: -0.5, originX: 1000.25, originY: 5000.75,
		datum: "WGS84", projection: "LOCAL", units: null, levelTableOffset: 0x59 });
});

test("georef flag 0 reads as no georeference", function () {
	assert.equal(parse({ georefFlag: 0 }).hasGeoreference, false);
});

test("widths above 2^31 read unsigned", function () {
	assert.equal(parse({ width: 0x90000000 }).width, 0x90000000);
});

test("16-char names with no NUL are read whole", function () {
	var h = parse({ datum: "ABCDEFGHIJKLMNOP", projection: "QRSTUVWXYZ012345" });
	assert.equal(h.datum, "ABCDEFGHIJKLMNOP");
	assert.equal(h.projection, "QRSTUVWXYZ012345");
});

test("wrong signature throws NOT_ECW at 0", function () {
	assert.throws(function () { parse({ signature: 0x89 }); }, { code: "NOT_ECW", offset: 0 });
});

test("version other than 2 throws UNSUPPORTED_VERSION at 1", function () {
	assert.throws(function () { parse({ version: 3 }); }, { code: "UNSUPPORTED_VERSION", offset: 1 });
});

test("buffer shorter than the fixed header throws TRUNCATED at 0x59", function () {
	assert.throws(function () { parse({ truncateAt: 0x40 }); }, { code: "TRUNCATED", offset: 0x59 });
});

test("truncation is checked before the signature", function () {
	assert.throws(function () { parseHeader(new MemorySource(Uint8Array.from([0x89, 0x50]))); }, { code: "TRUNCATED" });
});

test("zero width, height or bands throws NOT_ECW at the field", function () {
	assert.throws(function () { parse({ width: 0 }); }, { code: "NOT_ECW", offset: 0x06 });
	assert.throws(function () { parse({ height: 0 }); }, { code: "NOT_ECW", offset: 0x0A });
	assert.throws(function () { parse({ bands: 0 }); }, { code: "NOT_ECW", offset: 0x0E });
});
