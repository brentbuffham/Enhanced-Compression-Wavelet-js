// test/helpers/buildEcwHeader.js
//==========================================================
// Builds a synthetic ECW header (fixed fields + level table) in
// the layout from FINDINGS.md / spec §7. Values are made up; no
// sample data. Test-only.
//==========================================================

var DEFAULTS = {
	signature: 0x65, version: 2, levelCount: 3, width: 1000, height: 600, bands: 3,
	blockWidth: 64, blockHeight: 64, compressionTarget: 8, georefFlag: 1,
	cellSizeX: 0.5, cellSizeY: -0.5, originX: 1000.25, originY: 5000.75,
	datum: "WGS84", projection: "LOCAL"
};

function ceilLevels(width, height, count) {
	var list = [];
	for (var k = 0; k < count; k++) {
		var scale = Math.pow(2, count - k);
		list.push({ level: k, width: Math.ceil(width / scale), height: Math.ceil(height / scale), a: 1, b: 1, c: 1 });
	}
	return list;
}

function writeAscii(bytes, pos, text) {
	for (var i = 0; i < text.length && i < 16; i++) bytes[pos + i] = text.charCodeAt(i);
}

/**
 * @param {object} overrides - Any DEFAULTS field, plus `levels` and `truncateAt`.
 * @returns {Uint8Array}
 */
export function buildEcwHeader(overrides) {
	var f = Object.assign({}, DEFAULTS, overrides);
	var levels = f.levels || ceilLevels(f.width, f.height, f.levelCount);
	var bytes = new Uint8Array(0x59 + 21 * levels.length);
	var view = new DataView(bytes.buffer);
	bytes[0x00] = f.signature;
	bytes[0x01] = f.version;
	bytes[0x02] = 0x01;
	bytes[0x03] = 0x02;
	bytes[0x04] = f.levelCount;
	bytes[0x05] = 0x04;
	view.setUint32(0x06, f.width, false);
	view.setUint32(0x0A, f.height, false);
	view.setUint16(0x0E, f.bands, false);
	view.setUint16(0x10, 1, false);
	view.setUint16(0x12, f.blockWidth, false);
	view.setUint16(0x14, f.blockHeight, false);
	view.setUint16(0x16, f.compressionTarget, false);
	bytes[0x18] = f.georefFlag;
	view.setFloat64(0x19, f.cellSizeX, true);
	view.setFloat64(0x21, f.cellSizeY, true);
	view.setFloat64(0x29, f.originX, true);
	view.setFloat64(0x31, f.originY, true);
	writeAscii(bytes, 0x39, f.datum);
	writeAscii(bytes, 0x49, f.projection);
	levels.forEach(function (lv, i) {
		var p = 0x59 + 21 * i;
		bytes[p] = lv.level;
		view.setUint32(p + 1, lv.width, false);
		view.setUint32(p + 5, lv.height, false);
		view.setUint32(p + 9, lv.a, false);
		view.setUint32(p + 13, lv.b, false);
		view.setUint32(p + 17, lv.c, false);
	});
	return typeof f.truncateAt === "number" ? bytes.slice(0, f.truncateAt) : bytes;
}
