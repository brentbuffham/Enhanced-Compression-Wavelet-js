# Changelog

## 0.4.0 (2026-11-03)

- **New error code `UNSUPPORTED_MODE`.** A stream in a mode ecw-js doesn't decode now raises `UNSUPPORTED_MODE` instead of `BAD_BLOCK`, with `error.mode` holding the mode byte. Its message asks for an ECW that uses the mode, sent to blastingapps.com, so support can be added clean-room. `BAD_BLOCK` now means a damaged block only.
- **Errors name their block.** `BAD_BLOCK` and `UNSUPPORTED_MODE` errors raised from a block have `error.block` (`{ number, level, row, col, offset }`), and the message starts with the same location. `error.offset` is now always a file offset; it used to be relative to the block for stream table errors. Errors from workers keep these fields.
- **`onBadBlock: "skip"`** (opt-in) on `readRegion` and `readRegionToScratch`: streams that can't be decoded are read as empty, and the result lists them in `badBlocks`. Tiles built around skipped blocks are never cached. The default is still `"throw"`.
- `splitBlockStreams(bytes, bands, level, { offset, keepUnsupported })`: `offset` makes error offsets file offsets.
- README: the decoded stream modes are listed at the top.
- **World file and .prj sidecars.** `openEcw(file, { worldFile, prj })` takes a world file (`.eww`, `.ecww`, `.wld`) and a `.prj` as text or Files. `info` gains `crs` (WKT plus its name, datum, projection, units and any EPSG code), `worldFile`, `georefSource` and `warnings`, and `units` comes from the `.prj`. The header stays the source of the georeferencing, unless you pass `georef: "worldFile"`.
- New exports `parseWorldFile`, `parsePrj` and `pickSidecars`, which matches `site.ecw` to `site.eww` / `site.prj` in a list of files.
- `ecw-js/worker`: `open` passes `worldFile`, `prj` and `georef` through.
- Demo: drop or open the `.eww` / `.prj` together with the `.ecw`. The Info tab shows units, the world file, the CRS name and any warnings.
- Dev: `_dev/ecw-decode/modeCensus.mjs` reads every block's stream table and counts stream modes per level, listing the address of any stream the library doesn't decode. It reads a 3 GB file in about a second when the file is cached.

## 0.3.1 (2026-11-03)

Faster tile cache. Output is unchanged; the GDAL parity tests run with the cache on.

- Pans rebuild only the newly exposed tiles. Before, the cache rebuilt the bounding box of every missing tile, and after a diagonal pan that box covered nearly the whole view, so a pan cost more than a read with no cache. A pan now takes about half the time of an uncached read.
- New tiles are written to the cache in one pass, as the Int16 eighths it stores, instead of being cut out, copied and encoded separately.
- Tiles are 32 px by default (was 64): less padding to rebuild per window, so first reads are faster.
- A requested level too big for a quarter of the cache (a print-sized read) isn't cached. It would push out the coarser tiles that pans reuse. Full-resolution reads with the cache on now take about as long as with it off (0.3.0 was about 25% slower).
- OPFS tiles saved by 0.3.0 used 64-px tiles and aren't reused; they age out under `maxBytes` as usual.

## 0.3.0 (2026-11-02)

- **Several cores.** Large reads are split into bands of rows and decoded on a pool of workers. On a 4096 × 4096 full-resolution read in Chrome, 4 workers took about 0.9 s against 2.0 s on one thread. Output is unchanged, and the GDAL parity tests run with one thread and with two workers.
- `openEcw(file, { threads })`: unset or 0 is automatic (up to 4 workers for reads of 1 megapixel or more, started in the background so no read waits for them), 1 keeps reads on this thread, `n` uses `n` workers.
- With `cache: { opfs: true }`, automatic mode stays on this thread, so the OPFS tile cache keeps working as before.
- The pool closes after 30 seconds without use and on `close()`.
- New error code `WORKER_FAILED`: a worker stopped mid-read. Later reads run on this thread.
- `ecw-js/worker` and `createWorkerHandler`: `open` takes `threads`.
- Demo: a Threads control in the header, and the library version next to its name.
- Removed a block fetch path that 0.2.2's batched reads had left unused.

## 0.2.2 (2026-11-02)

- Faster reads from a `File`: each row of neighbouring blocks is read in two slices (its index entries, then its bytes) instead of two slices per block. About 13% faster on a full-resolution read from disk; output unchanged.
- `ecw-js/workerProtocol` exports `createWorkerHandler`, for hosts that install their own Worker handler.

## 0.2.1 (2026-11-02)

- Reads on a closed reader now fail with `INVALID_ARGUMENT` instead of running without the cache.
- `ecw-js/worker`: `open` takes `cache` (the same as `openEcw`). `open` and `close` abort the reads still running and wait for them before closing the file. A job `id` that is still running is rejected.
- `decodeStream` rejects an unknown stream mode with `BAD_BLOCK` instead of treating it as mode 2.
- `package.json` lists the worker entry under `sideEffects`.
- Docs: the format spec says the block-index length is big-endian; the README error table no longer lists `readRegionToScratch` as not implemented.
- Demo: opening a second file closes the first one's reader.
- The Pages site deploys only after the tests pass.

## 0.2.0 (2026-10-19)

- `transparentAbove: N` clears pixels whose R, G and B are all ≥ N (white collars, scanned-map margins).
- `transparentColor: { color, below, above }` clears pixels within a tolerance of a colour (`"#rrggbb"` or `[r, g, b]`); pass a list for several colours. Also exported as `applyColorKey(rgba, keys)`.
- All transparency options combine and are checked before decoding starts.
- Demo: a colour picker on the Clip tab, and a `transparentAbove` box.

## 0.1.0 (2026-10-19)

First release. Reads ECW version 2 files in the browser and in Node, bit for bit the same as the ECW SDK through GDAL on the files tested so far.

**Reading**

- `openEcw(fileOrBlob, options)` reads the header, georeferencing, colour space and resolution levels (`ecw.info`) without loading the file.
- Greyscale, RGB, multiband and the other ECW colour spaces: only the luma/chroma (YUV) space is colour-converted; the rest show their bands as stored (the first three, or one as grey).
- `readRegion` decodes any pixel window at any output size. It picks the coarsest resolution level that is still sharp enough and decodes only the blocks the window needs.
- `resample: "nearest"` (default, the same as GDAL and QGIS) or `"average"` (box-averaged, smoother).
- Optional `transparentBelow` (near-black background becomes transparent), `clipPolygon` (map-coordinate rings, holes supported) and `stretch` (QGIS-style contrast stretch, with `ecw.computeStretch()`).
- `readRegionToScratch` decodes outputs too big for memory in strips into an OPFS scratch file, byte for byte what `readRegion` would return.
- Progress callbacks, `AbortSignal` support, `OUTPUT_TOO_LARGE` guard (512 MB by default), and `EcwError` with stable codes.

**Speed**

- Reconstructed tiles are cached in memory by default (256 MB), so repeated and panned views come back several times faster. `cache: { opfs: true }` keeps them in OPFS across visits, keyed by a file fingerprint and the decoder version.

**Workers**

- `ecw-js/worker`: a ready-made module Worker with a small message protocol (open, readRegion, readRegionToScratch, abort, close). Pixel buffers are transferred, not copied.

**Lower layers** (exported for tooling and tests)

- Header, level table, block index and block framing parsers; the stream decoders (modes 2, 5 and 6); the inverse wavelet; the colour conversion; OPFS scratch-file helpers; `BlockCache`.

**Docs**

- `docs/ECW_FORMAT_SPEC.md`: the format as worked out from file bytes and black-box comparison with GDAL.
- A browser demo (drag and drop, block map, stream statistics, every library function from a side panel): https://brentbuffham.github.io/Enhanced-Compression-Wavelet-js/

**Limits**

- ECW version 2, read only. Real files tested: 3-band RGB with 64×64 blocks. Greyscale, multiband and the other colour spaces are checked against the ECW SDK on constructed files; real files of those kinds, other block sizes and ECW version 3 are untested.
