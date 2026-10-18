// src/workers/workerProtocol.js
//==========================================================
// Message protocol behind the ecw-js/worker entry, kept free of
// Worker globals so it can be driven directly (tests, custom hosts).
// In:  { id, type, payload }
//   open                { blob }            -> reader info
//   readRegion          readRegion options  -> { data, width, height, level, bounds }
//   readRegionToScratch readRegion options  -> { scratchId, width, height, level, bounds, byteLength }
//   abort               { id }              -> cancels that job (it rejects ABORTED)
//   close                                    -> closes the reader, removing its scratch files
// Out: { id, type: "progress", fraction, label } while a job runs, then
//      { id, type: "result", result } or { id, type: "error", code, message }.
// Pixel buffers are transferred, not copied. One open file per handler.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";
import { openEcw } from "../EcwReader.js";

/**
 * @param {function(object, Transferable[]=): void} post - postMessage-like sink.
 * @returns {function({id:*, type:string, payload?:object}): Promise<void>} message handler;
 *   its promise settles once the job's final message is posted
 */
export function createWorkerHandler(post) {
	var reader = null;
	var jobs = new Map();

	function needReader() {
		if (!reader) throw new EcwError(ERROR_CODES.INVALID_ARGUMENT, "no ECW file is open; send \"open\" first");
		return reader;
	}

	// Read options with this job's progress and abort wiring
	function readOptions(id, payload, controller) {
		return Object.assign({}, payload, {
			signal: controller.signal,
			onProgress: function (fraction, label) { post({ id: id, type: "progress", fraction: fraction, label: label }); }
		});
	}

	var handlers = {
		open: async function (id, payload) {
			if (reader) await reader.close();
			reader = null;
			reader = await openEcw(payload && payload.blob);
			return { result: reader.info };
		},
		readRegion: async function (id, payload, controller) {
			var img = await needReader().readRegion(readOptions(id, payload, controller));
			return { result: img, transfer: [img.data.buffer] };
		},
		readRegionToScratch: async function (id, payload, controller) {
			var out = await needReader().readRegionToScratch(readOptions(id, payload, controller));
			return { result: { scratchId: out.scratchId, width: out.width, height: out.height, level: out.level, bounds: out.bounds, byteLength: out.byteLength } };
		},
		abort: async function (id, payload) {
			var job = jobs.get(payload && payload.id);
			if (job) job.abort();
			return { result: { aborted: !!job } };
		},
		close: async function () {
			if (reader) await reader.close();
			reader = null;
			return { result: { closed: true } };
		}
	};

	return async function (msg) {
		var id = msg && msg.id;
		var handler = msg && Object.prototype.hasOwnProperty.call(handlers, msg.type) ? handlers[msg.type] : null;
		if (!handler) {
			post({ id: id, type: "error", code: ERROR_CODES.INVALID_ARGUMENT, message: "unknown message type " + (msg && msg.type) });
			return;
		}
		// Registered before the first await so an "abort" right after can find it
		var controller = new AbortController();
		jobs.set(id, controller);
		try {
			var out = await handler(id, msg.payload, controller);
			post({ id: id, type: "result", result: out.result }, out.transfer || []);
		} catch (err) {
			post({ id: id, type: "error", code: (err && err.code) || "ERROR", message: err && err.message ? err.message : String(err) });
		} finally {
			jobs.delete(id);
		}
	};
}
