// test/helpers/workers/waitsForAbort.js
// A pool worker entry whose rows tasks only end when aborted (answering ABORTED),
// except 2-row tasks, which answer at once with blank RGBA for a 64-pixel-wide read.
import { parentPort } from "node:worker_threads";

parentPort.on("message", function (m) {
	if (m.type === "open") parentPort.postMessage({ id: m.id, result: true });
	else if (m.type === "rows" && m.oy1 - m.oy0 === 2) parentPort.postMessage({ id: m.id, data: new ArrayBuffer(64 * 2 * 4) });
	else if (m.type === "abort") parentPort.postMessage({ id: m.id, error: { code: "ABORTED", message: "decode aborted" } });
});
parentPort.postMessage({ ready: true });
