// _dev/ecw-decode/recon.mjs
// Reconstructs Y/U/V float planes up to a given level image (k = 1 means the image built from level-0 subbands).
import { levelPlanes } from "./levelPlanes.mjs";
import { MODELS, synth2d } from "./testSynthesis.mjs";

export function reconstruct(f, upTo) {
	var L0 = levelPlanes(f, 0);
	var w = L0.width, h = L0.height;
	var cur = [0, 1, 2].map(function (b) { return synth2d(MODELS.empirical, L0.planes[b], w, h, "HL", "LH"); });
	var cw = 2 * w;
	for (var k = 1; k < upTo; k++) {
		var Lk = levelPlanes(f, k);
		var nw = Lk.width, nh = Lk.height;
		cur = [0, 1, 2].map(function (b) {
			var LL = new Float64Array(nw * nh);
			for (var y = 0; y < nh; y++) for (var x = 0; x < nw; x++) LL[y * nw + x] = cur[b][y * cw + x];
			return synth2d(MODELS.empirical, { LL: LL, LH: Lk.planes[b].LH, HL: Lk.planes[b].HL, HH: Lk.planes[b].HH }, nw, nh, "HL", "LH");
		});
		cw = 2 * nw;
	}
	return { planes: cur, width: cw };
}
