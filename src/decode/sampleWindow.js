// src/decode/sampleWindow.js
//==========================================================
// Samples a decoded level window to the output grid.
//   nearest: the level pixel under each output pixel centre (what GDAL
//            does, so output stays bit-exact with the ECW SDK)
//   average: area-weighted box average of the level pixels each output
//            pixel covers; smooth, alias-free downsampling between levels
// Runs on the Y / Cb / Cr bands, before colour conversion.
//==========================================================

/**
 * @param {Float32Array[]} bands - Level window planes, winW * winH each.
 * @param {number} winW
 * @param {number} winH
 * @param {{x:number, y:number, width:number, height:number}} region - Requested full-resolution window.
 * @param {number} scale - Full-resolution pixels per level pixel.
 * @param {number} lx0 - Level column of the window's first pixel.
 * @param {number} ly0 - Level row of the window's first pixel.
 * @param {number} outW
 * @param {number} outH
 * @param {"nearest"|"average"} mode
 * @param {number} [oy0=0] - First output row to produce (strips).
 * @param {number} [oy1=outH] - End output row (exclusive).
 * @returns {Float32Array[]} outW * (oy1 - oy0) per band
 */
export function sampleWindow(bands, winW, winH, region, scale, lx0, ly0, outW, outH, mode, oy0, oy1) {
	if (oy0 === undefined) oy0 = 0;
	if (oy1 === undefined) oy1 = outH;
	if (mode === "average") return sampleAverage(bands, winW, winH, region, scale, lx0, ly0, outW, outH, oy0, oy1);
	var out = bands.map(function () { return new Float32Array(outW * (oy1 - oy0)); });
	for (var oy = oy0; oy < oy1; oy++) {
		var sy = Math.min(winH - 1, Math.max(0, Math.floor((region.y + (oy + 0.5) * region.height / outH) / scale) - ly0));
		for (var ox = 0; ox < outW; ox++) {
			var sx = Math.min(winW - 1, Math.max(0, Math.floor((region.x + (ox + 0.5) * region.width / outW) / scale) - lx0));
			for (var b = 0; b < bands.length; b++) out[b][(oy - oy0) * outW + ox] = bands[b][sy * winW + sx];
		}
	}
	return out;
}

// Per output index in [o0, o1): the window pixels it covers and their area weights (summing to 1)
function boxWeights(start, extent, count, scale, l0, winLen, o0, o1) {
	var list = [];
	for (var o = o0; o < o1; o++) {
		var a = (start + o * extent / count) / scale - l0;
		var b = (start + (o + 1) * extent / count) / scale - l0;
		var idx = [], wts = [], sum = 0;
		for (var p = Math.floor(a); p < b; p++) {
			var cover = Math.min(b, p + 1) - Math.max(a, p);
			if (cover <= 0) continue;
			idx.push(Math.min(winLen - 1, Math.max(0, p)));
			wts.push(cover);
			sum += cover;
		}
		for (var i = 0; i < wts.length; i++) wts[i] /= sum;
		list.push({ idx: idx, wts: wts });
	}
	return list;
}

function sampleAverage(bands, winW, winH, region, scale, lx0, ly0, outW, outH, oy0, oy1) {
	var rowsOut = oy1 - oy0;
	var xs = boxWeights(region.x, region.width, outW, scale, lx0, winW, 0, outW);
	var ys = boxWeights(region.y, region.height, outH, scale, ly0, winH, oy0, oy1);
	return bands.map(function (src) {
		// Step 1) Rows: window rows x output columns
		var rows = new Float32Array(winH * outW);
		for (var y = 0; y < winH; y++) {
			for (var ox = 0; ox < outW; ox++) {
				var cx = xs[ox], v = 0;
				for (var i = 0; i < cx.idx.length; i++) v += src[y * winW + cx.idx[i]] * cx.wts[i];
				rows[y * outW + ox] = v;
			}
		}
		// Step 2) Columns
		var out = new Float32Array(outW * rowsOut);
		for (var oy = 0; oy < rowsOut; oy++) {
			var cy = ys[oy];
			for (var ox2 = 0; ox2 < outW; ox2++) {
				var s = 0;
				for (var j = 0; j < cy.idx.length; j++) s += rows[cy.idx[j] * outW + ox2] * cy.wts[j];
				out[oy * outW + ox2] = s;
			}
		}
		return out;
	});
}
