// src/errors.js
//==========================================================
// EcwError: every failure the library raises carries a stable
// `code` (see ERROR_CODES) and, for byte-level problems, the
// file `offset` where it was detected. Callers branch on `code`;
// the offset is appended to the message for humans.
//==========================================================

/** Stable error codes. Each value equals its key. */
export var ERROR_CODES = Object.freeze({
	NOT_ECW: "NOT_ECW",
	UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
	TRUNCATED: "TRUNCATED",
	BAD_LEVEL_TABLE: "BAD_LEVEL_TABLE",
	INVALID_ARGUMENT: "INVALID_ARGUMENT",
	OUTPUT_TOO_LARGE: "OUTPUT_TOO_LARGE",
	ABORTED: "ABORTED",
	NOT_IMPLEMENTED: "NOT_IMPLEMENTED"
});

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
