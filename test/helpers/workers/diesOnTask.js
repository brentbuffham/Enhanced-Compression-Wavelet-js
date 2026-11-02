// test/helpers/workers/diesOnTask.js
// A pool worker entry that opens fine, then exits in the middle of its first rows task.
import { parentPort } from "node:worker_threads";

parentPort.on("message", function (m) {
	if (m.type === "open") parentPort.postMessage({ id: m.id, result: true });
	else if (m.type === "rows") process.exit(3);
});
parentPort.postMessage({ ready: true });
