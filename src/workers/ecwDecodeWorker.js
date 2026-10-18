// src/workers/ecwDecodeWorker.js
//==========================================================
// Module Worker entry, exported as "ecw-js/worker":
//   new Worker(new URL("ecw-js/worker", import.meta.url), { type: "module" })
// Speaks the protocol in workerProtocol.js. Inside a Worker it is the
// natural home for readRegionToScratch, which needs sync OPFS access.
// Importing it outside a Worker does nothing.
//==========================================================

import { createWorkerHandler } from "./workerProtocol.js";

if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope) {
	var handle = createWorkerHandler(function (msg, transfer) { self.postMessage(msg, transfer || []); });
	self.onmessage = function (event) { handle(event.data); };
}
