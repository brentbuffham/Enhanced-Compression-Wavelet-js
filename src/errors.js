// src/errors.js
//==========================================================
// EcwError: every failure the library raises carries a stable
// `code` (see ERROR_CODES) and, for byte-level problems, the
// file `offset` where it was detected. Callers branch on `code`;
// the offset is appended to the message for humans. Errors raised
// from one block also carry `block` ({ number, level, row, col,
// offset }), and UNSUPPORTED_MODE carries the `mode` byte read.
//==========================================================

/** Stable error codes. Each value equals its key. */
export var ERROR_CODES = Object.freeze({
	NOT_ECW: "NOT_ECW",
	UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
	TRUNCATED: "TRUNCATED",
	BAD_LEVEL_TABLE: "BAD_LEVEL_TABLE",
	BAD_BLOCK_INDEX: "BAD_BLOCK_INDEX",
	BAD_BLOCK: "BAD_BLOCK",
	UNSUPPORTED_MODE: "UNSUPPORTED_MODE",
	INVALID_ARGUMENT: "INVALID_ARGUMENT",
	OUTPUT_TOO_LARGE: "OUTPUT_TOO_LARGE",
	ABORTED: "ABORTED",
	NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
	WORKER_FAILED: "WORKER_FAILED"
});

/** Where an UNSUPPORTED_MODE error asks for a sample of the mode. */
export var SAMPLE_REQUEST = "To help add it, please send an ECW file that uses this mode to blastingapps.com.";

/**
 * Error raised by ecw-js.
 * @param {string} code - One of ERROR_CODES.
 * @param {string} message - Human-readable description.
 * @param {number} [offset] - Byte offset in the file, when relevant.
 */
export class EcwError extends Error {
	constructor(code, message, offset) {
		var text = typeof offset === "number" ? message + " (at 0x" + offset.toString(16) + ")" : message;
		super(text);
		this.name = "EcwError";
		this.code = code;
		this.offset = offset;
	}
}

/**
 * An error as plain data, for postMessage.
 * @returns {{code:string, message:string, offset?:number, block?:object, mode?:number}}
 */
export function errorToData(err) {
	var out = { code: (err && err.code) || "ERROR", message: err && err.message ? err.message : String(err) };
	if (err && typeof err.offset === "number") out.offset = err.offset;
	if (err && err.block) out.block = err.block;
	if (err && typeof err.mode === "number") out.mode = err.mode;
	return out;
}

/**
 * Rebuild an EcwError from errorToData() output. The message already holds
 * its offset, so it isn't appended a second time.
 * @returns {EcwError}
 */
export function errorFromData(data, fallbackCode) {
	var e = new EcwError((data && data.code) || fallbackCode, data && data.message);
	if (data && typeof data.offset === "number") e.offset = data.offset;
	if (data && data.block) e.block = data.block;
	if (data && typeof data.mode === "number") e.mode = data.mode;
	return e;
}
