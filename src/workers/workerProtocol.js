// src/workers/workerProtocol.js
//==========================================================
// Message protocol behind the ecw-js/worker entry, kept free of
// Worker globals so it can be driven directly (tests, custom hosts).
// In:  { id, type, payload }
//   open                { blob, cache?, threads? } -> reader info (options as in openEcw)
//   readRegion          readRegion options  -> { data, width, height, level, bounds }
//   readRegionToScratch readRegion options  -> { scratchId, width, height, level, bounds, byteLength }
//   abort               { id }              -> cancels that job (it rejects ABORTED)
//   close                                    -> closes the reader, removing its scratch files
// Out: { id, type: "progress", fraction, label } while a job runs, then
//      { id, type: "result", result } or { id, type: "error", code, message }.
// Pixel buffers are transferred, not copied. One open file per handler:
// open and close abort the reads still running on the current file and
// wait for them to settle before closing it. A job id that is still
// running can't be reused.
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
	// running reads: id -> { controller, done }
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

	// Abort every running read and wait until each has posted its answer
	async function drainJobs() {
		var running = Array.from(jobs.values());
		running.forEach(function (job) { job.controller.abort(); });
		await Promise.all(running.map(function (job) { return job.done; }));
	}

	async function closeReader() {
		await drainJobs();
		if (reader) await reader.close();
		reader = null;
	}

	var handlers = {
		open: async function (id, payload) {
			await closeReader();
			var options = {};
			if (payload && payload.cache !== undefined) options.cache = payload.cache;
			if (payload && payload.threads !== undefined) options.threads = payload.threads;
			reader = await openEcw(payload && payload.blob, options);
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
			if (job) job.controller.abort();
			return { result: { aborted: !!job } };
		},
		close: async function () {
			await closeReader();
			return { result: { closed: true } };
		}
	};
	var READS = { readRegion: true, readRegionToScratch: true };

	return async function (msg) {
		var id = msg && msg.id;
		var handler = msg && Object.prototype.hasOwnProperty.call(handlers, msg.type) ? handlers[msg.type] : null;
		if (!handler) {
			post({ id: id, type: "error", code: ERROR_CODES.INVALID_ARGUMENT, message: "unknown message type " + (msg && msg.type) });
			return;
		}
		if (jobs.has(id)) {
			post({ id: id, type: "error", code: ERROR_CODES.INVALID_ARGUMENT, message: "job id " + id + " is already running" });
			return;
		}
		// Reads are registered before the first await so an "abort" right after can find them
		var controller = new AbortController();
		var settle;
		if (READS[msg.type]) jobs.set(id, { controller: controller, done: new Promise(function (resolve) { settle = resolve; }) });
		try {
			var out = await handler(id, msg.payload, controller);
			post({ id: id, type: "result", result: out.result }, out.transfer || []);
		} catch (err) {
			post({ id: id, type: "error", code: (err && err.code) || "ERROR", message: err && err.message ? err.message : String(err) });
		} finally {
			if (settle) {
				jobs.delete(id);
				settle();
			}
		}
	};
}
