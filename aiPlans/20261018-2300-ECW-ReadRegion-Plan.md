# ECW readRegion Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Promote the cracked codec into `src/` test-first and implement `readRegion`, so the library and the demo return real imagery (within ±3 of GDAL; exact parity is the follow-up hunt).

**Architecture:** Pure codec modules (`src/codec/`), a windowed recursive reconstructor that decodes only the blocks a window needs, and `EcwReader.readRegion` on top. Evidence for every rule: `_dev/ecw-decode/FINDINGS.md`.

**Spec:** `docs/superpowers/specs/2026-10-18-ecw-decoder-design.md` (§4 API, §6 data flow). Pass criterion is relaxed for this plan by Brent's decision (2026-10-18): ship within ±3, keep hunting the last ±1.

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
