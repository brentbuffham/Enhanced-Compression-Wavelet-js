// test/helpers/encodeMode3.js
//==========================================================
// Test-only mode-3 encoder (FINDINGS.md "mode 3 streams"): the
// carry-handling 31-bit range encoder with the mode byte as its
// header byte, a quasistatic 257-symbol model (total 4096, rebuild
// batches doubling from 36 to 2000), a lead byte 0 that isn't
// counted, then each value as little-endian int16, then the
// 3-byte big-endian payload length.
//==========================================================

var TOP = 0x80000000, SHIFT = 23, BOTTOM = 1 << 23, TOTAL = 4096, N = 257;

function model() {
	var m = { cf: new Array(N + 1).fill(0), newf: [], rescale: (N >> 4) | 2, nextleft: 0, left: 0, incr: 0 };
	m.cf[N] = TOTAL;
	for (var i = 0; i < N; i++) m.newf.push(Math.floor(TOTAL / N) + (i < TOTAL % N ? 1 : 0));
	rebuild(m);
	return m;
}
function rebuild(m) {
	if (m.nextleft) { m.incr++; m.left = m.nextleft; m.nextleft = 0; return; }
	if (m.rescale < 2000) m.rescale = Math.min(m.rescale * 2, 2000);
	var run = TOTAL, missing = TOTAL;
	for (var i = N - 1; i > 0; i--) { run -= m.newf[i]; m.cf[i] = run; m.newf[i] = (m.newf[i] >> 1) | 1; missing -= m.newf[i]; }
	m.newf[0] = (m.newf[0] >> 1) | 1;
	missing -= m.newf[0];
	m.incr = Math.floor(missing / m.rescale); m.nextleft = missing % m.rescale; m.left = m.rescale - m.nextleft;
}
function update(m, s) { if (m.left <= 0) rebuild(m); m.left--; m.newf[s] += m.incr; }

function encoder(header) {
	var s = { low: 0, range: TOP, buffer: header, help: 0, out: [] };
	function norm() {
		while (s.range <= BOTTOM) {
			if (s.low < 0xff * BOTTOM) { s.out.push(s.buffer & 0xff); for (; s.help; s.help--) s.out.push(0xff); s.buffer = (s.low >>> SHIFT) & 0xff; }
			else if (s.low >= TOP) { s.out.push((s.buffer + 1) & 0xff); for (; s.help; s.help--) s.out.push(0); s.buffer = (s.low >>> SHIFT) & 0xff; }
			else s.help++;
			s.range = (s.range * 256) >>> 0;
			s.low = ((s.low * 256) % TOP) >>> 0;
		}
	}
	return {
		encode: function (sf, lt, tot) { norm(); var r = Math.floor(s.range / tot), t = r * lt; s.low += t; if (lt + sf < tot) s.range = r * sf; else s.range -= t; },
		finish: function () {
			norm();
			var t = (s.low >>> SHIFT) + 1;
			if (t > 0xff) { s.out.push((s.buffer + 1) & 0xff); for (; s.help; s.help--) s.out.push(0); }
			else { s.out.push(s.buffer & 0xff); for (; s.help; s.help--) s.out.push(0xff); }
			s.out.push(t & 0xff);
			return s.out.slice(1); // the header byte is the stream's mode byte
		}
	};
}

/**
 * Encode values as a mode-3 payload (the bytes after the mode byte).
 * @param {number[]} values - int16 coefficients.
 * @param {{lead?: number}} [opts] - lead: the lead symbol (default 0).
 * @returns {Uint8Array}
 */
export function encodeMode3(values, opts) {
	var m = model(), e = encoder(3);
	function sym(b, counted) { e.encode(m.cf[b + 1] - m.cf[b], m.cf[b], TOTAL); if (counted) update(m, b); }
	sym(opts && opts.lead !== undefined ? opts.lead : 0, false);
	values.forEach(function (v) { var u = v & 0xffff; sym(u & 0xff, true); sym(u >> 8, true); });
	var payload = e.finish();
	var len = payload.length + 3;
	payload.push((len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
	return Uint8Array.from(payload);
}
