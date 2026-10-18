// test/helpers/readTiff.js
//==========================================================
// Minimal baseline TIFF reader for GDAL reference parity:
// II or MM, 8-bit samples, Compression 1, PlanarConfiguration 1,
// strips. Other tags (GeoTIFF keys etc.) are ignored.
// Test-only, never shipped.
//==========================================================

var TAG_WIDTH = 256;
var TAG_HEIGHT = 257;
var TAG_BITS = 258;
var TAG_COMPRESSION = 259;
var TAG_STRIP_OFFSETS = 273;
var TAG_SAMPLES = 277;
var TAG_STRIP_BYTES = 279;
var TAG_PLANAR = 284;
var TAG_TILE_WIDTH = 322;

var TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

function unsupported(what) {
	return new Error("unsupported TIFF: " + what);
}

/**
 * @param {Uint8Array} bytes
 * @returns {{width:number, height:number, samplesPerPixel:number, data:Uint8Array}}
 */
export function readTiff(bytes) {
	var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	var le;
	if (bytes[0] === 0x49 && bytes[1] === 0x49) le = true;
	else if (bytes[0] === 0x4D && bytes[1] === 0x4D) le = false;
	else throw unsupported("byte order");
	if (view.getUint16(2, le) !== 42) throw unsupported("version (BigTIFF?)");

	var ifd = view.getUint32(4, le);
	var count = view.getUint16(ifd, le);
	var tags = {};
	for (var i = 0; i < count; i++) {
		var p = ifd + 2 + i * 12;
		var tag = view.getUint16(p, le);
		var type = view.getUint16(p + 2, le);
		var n = view.getUint32(p + 4, le);
		if (type !== 3 && type !== 4) continue;
		var size = TYPE_SIZES[type];
		var at = n * size > 4 ? view.getUint32(p + 8, le) : p + 8;
		var values = [];
		for (var j = 0; j < n; j++) values.push(type === 3 ? view.getUint16(at + j * 2, le) : view.getUint32(at + j * 4, le));
		tags[tag] = values;
	}

	if (tags[TAG_TILE_WIDTH]) throw unsupported("tiles");
	if ((tags[TAG_COMPRESSION] || [1])[0] !== 1) throw unsupported("Compression " + tags[TAG_COMPRESSION][0]);
	if ((tags[TAG_PLANAR] || [1])[0] !== 1) throw unsupported("PlanarConfiguration");
	if (!(tags[TAG_BITS] || [8]).every(function (b) { return b === 8; })) throw unsupported("BitsPerSample");

	var width = tags[TAG_WIDTH][0];
	var height = tags[TAG_HEIGHT][0];
	var samplesPerPixel = (tags[TAG_SAMPLES] || [1])[0];
	var data = new Uint8Array(width * height * samplesPerPixel);
	var filled = 0;
	tags[TAG_STRIP_OFFSETS].forEach(function (offset, s) {
		var length = Math.min(tags[TAG_STRIP_BYTES][s], data.length - filled);
		data.set(bytes.subarray(offset, offset + length), filled);
		filled += length;
	});
	if (filled !== data.length) throw unsupported("strips cover " + filled + " of " + data.length + " bytes");
	return { width: width, height: height, samplesPerPixel: samplesPerPixel, data: data };
}
