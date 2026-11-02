// src/workers/poolProtocol.js
//==========================================================
// Message handling inside one decode-pool worker (src/decode/pool.js),
// kept free of Worker globals so tests can drive it directly.
// In:  { id, type: "open", blob, cache }          -> { id, result: true }
//      { id, type: "rows", opts, oy0, oy1 }       -> { id, data: ArrayBuffer } (transferred)
//      { type: "abort", id }                      -> that rows job ends with ABORTED
//      { type: "close" }                          -> closes the reader
// While rows run: { id, progress } at most every 2 %.
// Failures: { id, error: { code, message, offset } }.
// The worker opens the same Blob as the main thread (cloned, not
// copied) and decodes bands of output rows with the reader's own
// _plan / _decodeRows, so a band is byte for byte what one thread
// would produce.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";
import { openEcw } from "../EcwReader.js";

var PROGRESS_STEP = 0.02;

/**
 * @param {function(object, Transferable[]=): void} post - postMessage-like sink.
 * @returns {function(object): Promise<void>} message handler; settles once the reply is posted
 */
export function createPoolWorkerHandler(post) {
	var reader = null;
	var jobs = new Map();

	function fail(id, err) {
		post({ id: id, error: { code: (err && err.code) || "ERROR", message: err && err.message ? err.message : String(err), offset: err && err.offset } });
	}

	async function open(m) {
		if (reader) await reader.close();
		reader = null;
		// workers never start workers of their own
		reader = await openEcw(m.blob, { cache: m.cache, threads: 1 });
		post({ id: m.id, result: true });
	}

	async function rows(m) {
		if (!reader) throw new EcwError(ERROR_CODES.INVALID_ARGUMENT, "no ECW file is open in this worker");
		var controller = new AbortController();
		jobs.set(m.id, controller);
		try {
			var plan = reader._plan(Object.assign({}, m.opts, { signal: controller.signal }));
			var last = -1;
			var data = await reader._decodeRows(plan, m.oy0, m.oy1, function (f) {
				if (f - last < PROGRESS_STEP && f < 1) return;
				last = f;
				post({ id: m.id, progress: f });
			});
			post({ id: m.id, data: data.buffer }, [data.buffer]);
		} finally {
			jobs.delete(m.id);
		}
	}

	return async function (m) {
		try {
			if (m.type === "open") await open(m);
			else if (m.type === "rows") await rows(m);
			else if (m.type === "abort") { var job = jobs.get(m.id); if (job) job.abort(); }
			else if (m.type === "close") { if (reader) await reader.close(); reader = null; }
			else throw new EcwError(ERROR_CODES.INVALID_ARGUMENT, "unknown pool message type " + m.type);
		} catch (err) {
			fail(m.id, err);
		}
	};
}
