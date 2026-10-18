// examples/browser/demoWorker.js
//==========================================================
// Module Worker for the demo. Holds the dropped File and runs
// demoCore jobs off the main thread.
// In:  { id, type: "open" | "levelBlocks" | "inspect" | "sample" | "keep", payload }
// Out: { id, type: "progress", fraction, label }
//      { id, type: "result", result }   (typed arrays transferred)
//      { id, type: "error", code, message }
//==========================================================

import { openFile, readLevelBlockSizes, inspectBlock, sampleModes, keepFile } from "./lib/demoCore.js";

var state = null;

function progressFor(id) {
	return function (fraction, label) {
		self.postMessage({ id: id, type: "progress", fraction: fraction, label: label });
	};
}

var handlers = {
	open: async function (payload, onProgress) {
		var opened = await openFile(payload.file, onProgress);
		state = { file: payload.file, opened: opened };
		return opened;
	},
	levelBlocks: function (payload, onProgress) {
		return readLevelBlockSizes(state.file, state.opened.index, state.opened.grid, payload.level, onProgress);
	},
	inspect: function (payload) {
		return inspectBlock(state.file, state.opened.index, state.opened.grid, state.opened.info, payload.n);
	},
	keep: function (payload, onProgress) {
		return keepFile(state.file, payload.name, onProgress);
	},
	sample: function (payload, onProgress) {
		return sampleModes(state.file, state.opened.index, state.opened.grid, state.opened.info, payload.level, payload.count, onProgress);
	}
};

self.onmessage = async function (event) {
	var msg = event.data;
	try {
		if (msg.type !== "open" && !state) throw new Error("no file open");
		var result = await handlers[msg.type](msg.payload, progressFor(msg.id));
		var transfer = result && result.sizes ? [result.sizes.buffer] : [];
		self.postMessage({ id: msg.id, type: "result", result: result }, transfer);
	} catch (err) {
		self.postMessage({ id: msg.id, type: "error", code: err.code || "ERROR", message: err.message });
	}
};
