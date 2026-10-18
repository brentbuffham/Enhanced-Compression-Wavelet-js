// src/index.js
//==========================================================
// Public entry point for ecw-js.
// VERSION is kept in step with package.json by test/package.test.js
// (a JSON import would need import attributes in browsers).
//==========================================================

/** Library version, matches package.json. */
export var VERSION = "0.0.1";

export { openEcw } from "./EcwReader.js";
export { EcwError, ERROR_CODES } from "./errors.js";
export { parseHeader } from "./format/EcwHeader.js";
export { parseLevels } from "./format/EcwLevels.js";
export { pixelWindowToBounds } from "./format/georef.js";
export { MemorySource } from "./io/MemorySource.js";
export { BlobSource } from "./io/BlobSource.js";
export { parseBlockIndex, blockGrid, blockEntryWindow, levelEntryWindow, blockByteRange } from "./format/EcwBlockIndex.js";
export { splitBlockStreams, STREAM_MODE } from "./format/EcwBlockFrame.js";
export { applyTransparency } from "./post/applyTransparency.js";
export { clipToPolygon } from "./post/clipToPolygon.js";
export { SCRATCH_DIR, openScratchSyncWriter, openScratchReader, removeScratchFile, sweepStaleScratchFiles, listScratchFiles, getScratchFile } from "./io/ScratchBinaryFile.js";
