// src/workers/decodePoolWorker.js
//==========================================================
// Worker entry for the decode pool (src/decode/pool.js): a browser
// module Worker or a Node worker_threads Worker running
// createPoolWorkerHandler. Posts { ready: true } once it listens; the
// pool waits for that before sending work. Importing it on a main
// thread does nothing.
//==========================================================

import { createPoolWorkerHandler } from "./poolProtocol.js";

// node:worker_threads is named at run time so browser bundlers leave it alone
var NODE_WORKER_THREADS = ["node", "worker_threads"].join(":");

if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope) {
	var handle = createPoolWorkerHandler(function (m, t) { self.postMessage(m, t || []); });
	self.onmessage = function (e) { handle(e.data); };
	self.postMessage({ ready: true });
} else if (typeof process !== "undefined" && process.versions && process.versions.node) {
	import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_WORKER_THREADS).then(function (wt) {
		if (wt.isMainThread || !wt.parentPort) return;
		var port = wt.parentPort;
		var handleNode = createPoolWorkerHandler(function (m, t) { port.postMessage(m, t || []); });
		port.on("message", handleNode);
		port.postMessage({ ready: true });
	});
}
