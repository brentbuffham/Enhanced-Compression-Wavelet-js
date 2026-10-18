// test/helpers/writeTiff.js
//==========================================================
// Writes a minimal baseline TIFF (8-bit, chunky, strips) to
// build fixtures for readTiff tests. Test-only.
//==========================================================

var TYPE_SHORT = 3;
var TYPE_LONG = 4;

/**
 * @param {{width:number, height:number, samplesPerPixel:number, data:Uint8Array,
 *   bigEndian?:boolean, rowsPerStrip?:number, compression?:number}} o
 * @returns {Uint8Array}
 */
export function writeTiff(o) {
	var le = !o.bigEndian;
	var spp = o.samplesPerPixel;
	var rowsPerStrip = o.rowsPerStrip || o.height;
	var stripCount = Math.ceil(o.height / rowsPerStrip);
	var rowBytes = o.width * spp;
	var entries = [
		[256, TYPE_LONG, [o.width]],
		[257, TYPE_LONG, [o.height]],
		[258, TYPE_SHORT, new Array(spp).fill(8)],
		[259, TYPE_SHORT, [o.compression || 1]],
		[262, TYPE_SHORT, [spp >= 3 ? 2 : 1]],
		[273, TYPE_LONG, new Array(stripCount).fill(0)],
		[277, TYPE_SHORT, [spp]],
		[278, TYPE_LONG, [rowsPerStrip]],
		[279, TYPE_LONG, []],
		[284, TYPE_SHORT, [1]]
	];
	for (var s = 0; s < stripCount; s++) {
		entries[8][2].push(Math.min(rowsPerStrip, o.height - s * rowsPerStrip) * rowBytes);
	}
	var ifdSize = 2 + entries.length * 12 + 4;
	var extraStart = 8 + ifdSize;
	var extraSize = entries.reduce(function (sum, e) {
		var bytes = e[2].length * (e[1] === TYPE_SHORT ? 2 : 4);
		return sum + (bytes > 4 ? bytes : 0);
	}, 0);
	var dataStart = extraStart + extraSize;
	for (s = 0; s < stripCount; s++) entries[5][2][s] = dataStart + s * rowsPerStrip * rowBytes;

	var out = new Uint8Array(dataStart + o.data.length);
	var view = new DataView(out.buffer);
	out[0] = out[1] = le ? 0x49 : 0x4D;
	view.setUint16(2, 42, le);
	view.setUint32(4, 8, le);
	view.setUint16(8, entries.length, le);
	var extra = extraStart;
	entries.forEach(function (e, i) {
		var p = 10 + i * 12;
		var size = e[1] === TYPE_SHORT ? 2 : 4;
		view.setUint16(p, e[0], le);
		view.setUint16(p + 2, e[1], le);
		view.setUint32(p + 4, e[2].length, le);
		var at = e[2].length * size > 4 ? extra : p + 8;
		if (at === extra) {
			view.setUint32(p + 8, extra, le);
			extra += e[2].length * size;
		}
		e[2].forEach(function (v, j) {
			if (size === 2) view.setUint16(at + j * 2, v, le);
			else view.setUint32(at + j * 4, v, le);
		});
	});
	view.setUint32(10 + entries.length * 12, 0, le);
	out.set(o.data, dataStart);
	return out;
}
