# ECW readRegion Implementation Plan (Plan 3)

**Goal:** Promote the cracked codec into `src/` test-first and implement `readRegion`, so the library and the demo return real imagery (within ±3 of GDAL; exact parity is the follow-up hunt).

**Architecture:** Pure codec modules (`src/codec/`), a windowed recursive reconstructor that decodes only the blocks a window needs, and `EcwReader.readRegion` on top. Evidence for every rule: `_dev/ecw-decode/FINDINGS.md`.

**Spec:** `docs/design/2026-10-18-ecw-decoder-design.md` (§4 API, §6 data flow). Pass criterion is relaxed for this plan by Brent's decision (2026-10-18): ship within ±3, keep hunting the last ±1.

## Global Constraints

Plan 1 constraints apply (zero deps, `node --test`, test-first, style, no private data in tests or git).

## Review Focus

1. **Windows at image edges** (right/bottom partial blocks, last row 1 px high): reconstruction clamps at the level's true size, never reads past a block.
2. **Huge requests**: output above `maxOutputBytes` (512 MB) throws `OUTPUT_TOO_LARGE` before any decoding.
3. **Abort mid-decode**: an aborted `signal` rejects with `ABORTED` promptly (checked between blocks).
4. **Downsampled reads** pick the coarsest level that is still at least as sharp as requested, so a whole-image thumbnail never decodes full resolution.
5. **Out-of-range windows** (negative, zero size, beyond the image) throw `INVALID_ARGUMENT`.

---

### Task 1: Stream decoders — `src/codec/streams.js`
- `decodeMode6(bytes, count) → Int32Array`; `decodeMode2(bytes, count) → Int32Array`; `decodeStream({mode, bytes}, count) → Int32Array` (mode 5 → zeros). Malformed (odd length, overrun, short data, bad tree) → `EcwError(BAD_BLOCK)`.
- Tests: hand-built words; a test-only mode-2 encoder (`test/helpers/encodeMode2.js`) round-trips symbol sequences; tree with all token kinds; truncated data; count mismatch.

### Task 2: Wavelet synthesis — `src/codec/wavelet.js`
- `synthesizeWindow(S, D, out)`: generic 2-D window synthesis with accessor callbacks clamped to the level's global size; rows use `HL` as high-pass, columns `LH`/`HH`; even `s − (d[n−1]+d[n])/2`, odd `(s[n]+s[n+1])/2 + d[n]`.
- Tests: constant LL + zero details stays constant; single detail coefficient gives the hand-computed pattern; window result equals the matching crop of a full-image synthesis; edge clamping.

### Task 3: Colour — `src/codec/colour.js`
- `yuvToRgba(Y, U, V, rgba)`: BT.601 (`1.402`, `0.344136`, `0.714136`, `1.772`), +0.5 on R and B, round, clamp, alpha 255; 1-band files map grey.
- Tests: zero → (1,0,1,255); clamping; grey path.

### Task 4: Region decoder — `src/decode/RegionDecoder.js`
- `decodeWindow(ctx, imageLevel, x0, y0, x1, y1) → { Y, U, V } Float32Arrays` recursive: image level 0 = record-0 LL; level j+1 window needs level-j window ±1 plus record-j details. Blocks fetched through `ctx.fetchBlock(n) → Promise<Uint8Array>`, decoded once per call (in-call cache).
- Tests on synthetic multi-level files built with mode-6 streams (constant image; single detail) and window-vs-full equality.

### Task 5: `EcwReader.readRegion` + sample parity
- Level choice, window mapping, nearest resampling to `outWidth × outHeight`, post-steps, errors, progress, abort. Export new codec functions.
- Sample test: reads matching `samples/ref/level-2.tif`, `level-5.tif` and the three full-res crops: max error ≤ 3, ≥ 40% exact (documents current state).

### Task 6: Demo Read tab
- `readRegion` runs in the demo Worker; the Read tab shows the decoded image; a "Whole image" button fills the form for a viewer-sized thumbnail.

### Task 7: `readRegionToScratch` (strips into OPFS)
- Same validation, level choice and sampling as `readRegion`; output rows are decoded in strips of at most `stripBytes` (default 64 MB of RGBA) and streamed into an OPFS scratch file with `openScratchSyncWriter` (Worker or Node with an injected root: `scratch: { root, dir }`).
- File holds raw RGBA rows, top to bottom, `width * 4` bytes each. Result `{ scratchId, width, height, level, bounds, byteLength, openReader() }`; `openReader()` → `openScratchReader(scratchId, { byteLength })`.
- A fresh decode context per strip keeps the block cache bounded. `transparentBelow` / `clipPolygon` apply per strip with the strip's first row, so bytes equal `readRegion` exactly.
- Abort or error removes the scratch file and rejects. `close()` removes the reader's scratch files.
- Tests: bytes equal `readRegion` for nearest, average, clip + transparency with several strips; abort removes the file; invalid args reject before any file is created; `close()` removes files.

### Task 9: `BlockCache` (reconstructed tiles, memory + OPFS)
- Profile first (sample, 2048² views): wavelet synthesis 67% of decode time, coefficient copies 11%, stream decoding ~3%, blob reads ~4%.
- Ruling: the "decoded-block cache" caches reconstructed level tiles, not decoded streams — streams are ~3% of the cost; the spec's "cache keeps intermediate levels" is the part that pays. Cost if wrong: a stream cache could be added beside it.
- Ruling: tiles are stored floored to eighths (Int16, value × 8; Float32 fallback). Intermediates already use eighths; the requested level only ever reaches floor() in the colour step and floor(floor8(v)) = floor(v), so nearest output is unchanged (sample parity still exact). readRegion floors its window to eighths always, so "average" is identical with or without a cache. Cost if wrong: one more 2-byte plane per band.
- Ruling: 64-px tiles, 256 MB memory by default (64 MB thrashed on a 2048² view). Measured on the sample: first view +23%, ×2 zoom-in −22%, repeat −89%. The first-view cost is tile snapping pulling in an extra ring of blocks per level; faster synthesis would shrink it.
- Ruling: OPFS writes go into ~8 MB pack files with an index footer, flushed at the end of each read; one file per tile cost 23.8 s for a thumbnail (4,440 files) in Chrome. Whole packs are read back once and kept (4) for later tiles. Chrome: thumbnail 3.2 s uncached, 3.4 s while writing packs, 363 ms reopened after a reload.
- OPFS tier opt-in (`cache: { opfs: true }`), keyed by fileFingerprint (name, size, lastModified, first 4 KB, CACHE_VERSION); failures are misses, never errors.

### Task 10: Synthesis speed-up
- Guard: a frozen copy of the straightforward synthesis (test/helpers/referenceWavelet.js) and a 300-case random equivalence test (windows, edges, odd sizes, per-coefficient subband masks), checked to catch planted rounding and indexing mutations.
- synthesizeWindow: row-major passes with precomputed clamped row offsets (no per-sample closures), floored averages only on odd rows, subbandsAt once per coefficient per row with an all-subbands fast path. Coefficient copies use native typed-array set for long rows.
- Tile cache: tiles hand out their Int16 planes with scale 1/8 (no decode copy); the bounding box of the missing tiles is synthesised in one call, then split and stored.
- Sample, 2048² views: uncached first view 970 -> 608 ms; cached first view 1200 -> 821 ms, x2 zoom-in 735 -> 483 ms, repeat ~120 ms. Thumbnail uncached 1889 -> 1020 ms.

### Task 8: Worker entry `ecw-js/worker`
- `src/workers/ecwDecodeWorker.js`: message protocol `{ id, type: "open" | "readRegion" | "readRegionToScratch" | "close", payload }` in; `{ id, type: "progress" | "result" | "error" }` out; pixel buffers transferred. Protocol logic lives in a pure `createWorkerHandler(post)` so Node tests drive it without a Worker.
- `package.json` exports `./worker`.
