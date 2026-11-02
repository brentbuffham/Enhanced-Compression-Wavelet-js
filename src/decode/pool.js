// src/decode/pool.js
//==========================================================
// A pool of workers that decode bands of output rows in parallel
// (src/workers/decodePoolWorker.js). Browser module Workers or Node
// worker_threads. Every worker opens the same Blob (cloned, not
// copied), so only the decoded RGBA crosses back, transferred.
// Tasks are pinned: rows(i, ...) always runs on worker i, in order,
// so a repeated or panned read finds its tiles in that worker's cache.
// If any worker can't start or can't open the file, createDecodePool
// returns null and the reader decodes on its own thread. A worker that
// fails later breaks the pool: its tasks, and all later ones, reject
// with WORKER_FAILED.
// Patterns shared with las-laz-js (src/laz/pool.js): ready handshake,
// --input-type stripped from Node workers, idle Node workers unref'd.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";

var NODE_WORKER_THREADS = ["node", "worker_threads"].join(":");
var NODE_OS = ["node", "os"].join(":");
var MAX_THREADS = 16;

/**
 * Workers available by default: one fewer than the cores, at most 16.
 * @returns {Promise<number>}
 */
export async function defaultThreads() {
	var cores = 1;
	if (typeof navigator !== "undefined" && navigator.hardwareConcurrency) cores = navigator.hardwareConcurrency;
	else {
		try {
			var os = await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_OS);
			cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
		} catch (e) { cores = 1; }
	}
	return Math.max(1, Math.min(MAX_THREADS, cores - 1));
}

// Node worker options: the parent's flags are inherited, except --input-type
// (node --input-type=module -e passes it on, and a worker has no string input for it)
export function nodeWorkerOptions(argv) {
	var isInputType = function (a, i) { return /^--input-type(=|$)/.test(a) || argv[i - 1] === "--input-type"; };
	if (!argv.some(isInputType)) return undefined;
	return { execArgv: argv.filter(function (a, i) { return !isInputType(a, i); }) };
}

// One worker behind a small interface. Resolves once the worker says it is
// ready; rejects if it fails or exits first, so a pool that can't start is
// known before any task is sent.
async function spawn(onMessage, onFail, nodeUrl) {
	var started = false, closing = false, ready, failed;
	var up = new Promise(function (res, rej) { ready = res; failed = rej; });
	function message(m) { if (m && m.ready) { started = true; ready(); } else onMessage(m); }
	function error(e) { if (closing) return; if (started) onFail(e); else failed(e); }
	var handle;
	if (typeof Worker === "function") {
		// written inline so bundlers (Vite, Rollup, webpack 5) see the worker and emit it
		var w = new Worker(new URL("../workers/decodePoolWorker.js", import.meta.url), { type: "module" });
		w.onmessage = function (e) { message(e.data); };
		w.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); error(new Error(e && e.message ? e.message : "an ECW decode worker failed")); };
		// a reply that can't be read raises no message event: without this its task would wait for ever
		w.onmessageerror = function () { error(new Error("an ECW decode worker sent a reply that could not be read")); };
		handle = { post: function (m, t) { w.postMessage(m, t || []); }, close: function () { closing = true; w.terminate(); } };
	} else {
		var wt = await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_WORKER_THREADS);
		var nw = new wt.Worker(nodeUrl || new URL("../workers/decodePoolWorker.js", import.meta.url), nodeWorkerOptions(process.execArgv));
		nw.on("message", message);
		nw.on("error", error);
		nw.on("messageerror", error);
		nw.on("exit", function (code) { error(new Error("an ECW decode worker exited (" + code + ")")); });
		// Node keeps running while a worker has a task, not while it idles
		handle = { post: function (m, t) { nw.postMessage(m, t || []); }, close: function () { closing = true; nw.terminate(); },
			hold: function () { nw.ref(); }, release: function () { nw.unref(); } };
	}
	try { await up; } catch (e) { handle.close(); throw e; }
	if (handle.release) handle.release();
	return handle;
}

/**
 * Start n workers and open the file in each.
 * @param {number} n - Workers to start.
 * @param {Blob} blob - The ECW file.
 * @param {false|{tileSize?:number, memoryBytes?:number}} cache - Each worker's tile cache (memory only).
 * @param {URL} [nodeUrl] - A Node worker entry in place of decodePoolWorker.js (tests).
 * @returns {Promise<{size:number, broken:boolean,
 *   rows:function(number, {opts:object, oy0:number, oy1:number}, function(number)=, AbortSignal=): Promise<Uint8ClampedArray>,
 *   close:function(): void}|null>}
 */
export async function createDecodePool(n, blob, cache, nodeUrl) {
	var workers = [], waiting = new Map(), nextId = 1, closed = false, brokenBy = null;

	function failAll(err) {
		function end(job) { if (job.unlisten) job.unlisten(); job.reject(err); }
		waiting.forEach(end);
		waiting.clear();
		workers.forEach(function (w) {
			w.queue.forEach(end);
			w.queue = [];
			w.busy = null;
		});
	}

	function onFail(err) {
		if (closed || brokenBy) return;
		brokenBy = new EcwError(ERROR_CODES.WORKER_FAILED, "an ECW decode worker failed: " + (err && err.message ? err.message : String(err)));
		failAll(brokenBy);
	}

	function pump(w) {
		if (w.busy || !w.queue.length) return;
		var job = w.queue.shift();
		w.busy = job;
		waiting.set(job.msg.id, job);
		if (w.handle.hold) w.handle.hold();
		try { w.handle.post(job.msg); } catch (e) {
			// a task that can't be sent fails alone; the worker stays free
			finish(w, job);
			job.reject(new EcwError(ERROR_CODES.WORKER_FAILED, "could not send a task to an ECW decode worker: " + (e && e.message ? e.message : String(e))));
		}
	}

	function finish(w, job) {
		waiting.delete(job.msg.id);
		if (job.unlisten) job.unlisten();
		w.busy = null;
		if (!w.queue.length && w.handle.release) w.handle.release();
		pump(w);
	}

	function onMessage(w, m) {
		var job = waiting.get(m.id);
		if (!job) return;
		if (m.progress !== undefined) { if (job.onProgress) job.onProgress(m.progress); return; }
		finish(w, job);
		if (m.error) job.reject(new EcwError(m.error.code || ERROR_CODES.WORKER_FAILED, m.error.message, m.error.offset));
		else job.resolve(m);
	}

	function send(w, msg, onProgress, signal) {
		if (closed) return Promise.reject(new EcwError(ERROR_CODES.ABORTED, "the ECW decode pool is closed"));
		if (brokenBy) return Promise.reject(brokenBy);
		if (signal && signal.aborted) return Promise.reject(new EcwError(ERROR_CODES.ABORTED, "decode aborted"));
		return new Promise(function (resolve, reject) {
			var job = { msg: Object.assign({ id: nextId++ }, msg), onProgress: onProgress, resolve: resolve, reject: reject };
			if (signal) {
				var onAbort = function () {
					var q = w.queue.indexOf(job);
					if (q >= 0) {
						w.queue.splice(q, 1);
						job.unlisten();
						reject(new EcwError(ERROR_CODES.ABORTED, "decode aborted"));
					} else if (w.busy === job) {
						// the worker answers ABORTED once it notices
						try { w.handle.post({ type: "abort", id: job.msg.id }); } catch (e) { /* the worker is gone; failAll answers */ }
					}
				};
				signal.addEventListener("abort", onAbort);
				job.unlisten = function () { signal.removeEventListener("abort", onAbort); };
			}
			w.queue.push(job);
			pump(w);
		});
	}

	var starts = [];
	for (var i = 0; i < n; i++) {
		starts.push((function (slot) {
			return spawn(function (m) { onMessage(slot, m); }, onFail, nodeUrl).then(function (handle) { slot.handle = handle; return slot; });
		})({ queue: [], busy: null, handle: null }));
	}
	var settled = await Promise.allSettled(starts);
	workers = settled.filter(function (s) { return s.status === "fulfilled"; }).map(function (s) { return s.value; });
	function closeAll() { workers.forEach(function (w) { w.handle.close(); }); }
	if (workers.length < n) {
		closeAll();
		return null;
	}
	try {
		await Promise.all(workers.map(function (w) { return send(w, { type: "open", blob: blob, cache: cache }); }));
	} catch (e) {
		// a worker that can't open the file means this thread decodes
		closed = true;
		closeAll();
		return null;
	}

	return {
		size: n,
		get broken() { return !!brokenBy; },
		/**
		 * Decode output rows [task.oy0, task.oy1) of a read on worker i.
		 * @param {number} i - Worker index, 0 .. size - 1.
		 * @param {{opts:object, oy0:number, oy1:number}} task - opts: readRegion options that survive postMessage.
		 * @param {function(number)} [onProgress] - The band's share done, 0..1.
		 * @param {AbortSignal} [signal]
		 * @returns {Promise<Uint8ClampedArray>} RGBA, outWidth * (oy1 - oy0) * 4 bytes
		 */
		rows: function (i, task, onProgress, signal) {
			return send(workers[i], { type: "rows", opts: task.opts, oy0: task.oy0, oy1: task.oy1 }, onProgress, signal)
				.then(function (m) { return new Uint8ClampedArray(m.data); });
		},
		/** Terminate every worker; queued and running tasks reject ABORTED. Safe to call more than once. */
		close: function () {
			if (closed) return;
			closed = true;
			failAll(new EcwError(ERROR_CODES.ABORTED, "the ECW decode pool was closed"));
			closeAll();
		}
	};
}
