# ECW Decoder — Design Spec

- **Status:** Draft for review
- **Date:** 2026-10-18
- **Repo:** `brentbuffham/Enhanced-Compression-Wavelet-js` (public, MIT)
- **npm name:** `ecw-js` (free on npm as of 2026-10-18)

## 1. Intent

A standalone, MIT-licensed, zero-dependency JavaScript library that reads ERDAS ECW raster files.
It is published to npm and usable by any consumer; Kirra is one consumer, not a design input.

The format is reverse-engineered **from file bytes only**.
No ECW SDK source (libecw or Hexagon) is read, copied or translated at any point.
Ground truth comes from decoding the same file with QGIS's bundled GDAL (ECW SDK 5.5) as a black box.

**Success:** for a real ECW file, `readRegion` output matches GDAL's decode of the same window, pixel for pixel.

## 2. Ground rules

1. Vanilla JavaScript ES modules only. No runtime dependencies, no dev dependencies, no build step.
2. Tests run on Node's built-in runner (`node --test`).
3. OPFS scratch binary files hold large decoded outputs and the decoded-block cache. Input files are read in place with `File.slice`.
4. Reverse-engineering method follows Kirra's DUF / BMF / Vulcan work (section 8).
5. Test-driven per the superpowers `test-driven-development` skill: every behaviour lands as a failing test first, then the code that passes it.
6. No completion claim without running the tests and showing the output (superpowers `verification-before-completion`).
7. Sample data is private. Real ECW files and anything derived from them live in gitignored `samples/` and are never committed or published.

## 3. Scope

**v1 in scope**

- ECW header, georeferencing, resolution-level table, block offset table.
- Decode any region at any resolution level to RGBA (and greyscale / multiband to RGBA by documented mapping).
- Browser (main thread and Worker) and Node for the pure decode layers.

**v1 out of scope**

- JPEG 2000 (`.jp2`), writing ECW, ECWP network streaming, `.eww` / `.ers` sidecar parsing beyond what the header needs.

**Transparency and clipping (opt-in, v1)**

ECW v2 has no alpha band. Off-footprint areas in real files are lossy near-black (values 0–2 per band, smeared at edges), not exact zeros.
By default output stays faithful to GDAL and alpha is always 255. Two optional post-decode steps set alpha to 0:

- `transparentBelow: N` — a pixel whose every band is ≤ N becomes transparent.
- `clipPolygon: rings` — pixels outside the polygon become transparent. `rings` is an array of rings, each an array of `[x, y]` in the file's map coordinates; even-odd fill, so inner rings are holes. A pixel is inside when its centre is inside.

Both apply after resampling, to `readRegion` and `readRegionToScratch` alike, and can be combined.

## 4. Public API

```js
import { openEcw } from "ecw-js";

var ecw = await openEcw(fileOrBlob, { worker: true });
ecw.info;
// { width, height, bands, blockWidth, blockHeight, levels, version,
//   cellSizeX, cellSizeY, originX, originY, datum, projection, units }

var img = await ecw.readRegion({ x, y, width, height, outWidth, outHeight,
	transparentBelow, clipPolygon, onProgress, signal });
// { data: Uint8ClampedArray (RGBA), width, height, level, bounds: { minX, minY, maxX, maxY } }

var out = await ecw.readRegionToScratch({ x, y, width, height, outWidth, outHeight, onProgress, signal });
// { scratchId, width, height, level, bounds, openReader() }   // rows streamed into OPFS

ecw.close(); // terminates the worker and deletes this reader's scratch files
```

- `x, y, width, height` are full-resolution pixel coordinates; `outWidth/outHeight` default to `width/height`.
- `readRegion` throws `EcwError("OUTPUT_TOO_LARGE")` above `maxOutputBytes` (default 512 MB); callers then use `readRegionToScratch`.
- `signal` is an `AbortSignal`; abort rejects with `EcwError("ABORTED")` and cleans scratch.
- Lower layers (`parseHeader`, `parseBlockIndex`, `decodeBlock`, …) are also exported for tooling and tests.

## 5. Architecture

Layered as in Kirra's BMF parser; each layer is pure and DOM-free so it runs in a Worker or Node.

| Path | Responsibility |
|---|---|
| `src/io/ByteSource.js` | The source contract: `length()`, `slice(start, end)`, `getUint8/16/32`, `getInt32`, `getFloat64(pos, littleEndian)`, plus `readU64(pos, le)` built by multiplication, never `<<`, returning `null` past 2^53. |
| `src/io/MemorySource.js` | Contract over a `Uint8Array`. |
| `src/io/BlobSource.js` | Async reader over a `File`/`Blob`: `read(start, end)` → `Promise<Uint8Array>` via `slice().arrayBuffer()`. Not the sync contract; callers read a range, then parse it through `MemorySource` (Kirra's windowed-header pattern). |
| `src/io/ScratchBinaryFile.js` | OPFS: async writer (main thread), sync writer with `writeAt` (worker), `ScratchSource` reader with sliding window, remove, 24 h stale sweep. Modelled on Kirra's `ScratchBinaryFile.js`. |
| `src/format/EcwHeader.js` | Fixed header and georeferencing. |
| `src/format/EcwLevels.js` | Resolution-level table and level dimensions. |
| `src/format/EcwBlockIndex.js` | Block offset table → `{ level, row, col, offset, length }`. |
| `src/codec/*.js` | Entropy decode, dequantise, inverse wavelet, colour transform — one file per stage, filled in as each is cracked. |
| `src/post/applyTransparency.js` | `transparentBelow` threshold → alpha 0. |
| `src/post/clipToPolygon.js` | Scanline even-odd rasterisation of map-coordinate rings onto the output grid via `bounds` → alpha 0 outside. |
| `src/cache/BlockCache.js` | Decoded-block cache in OPFS keyed by file fingerprint + level + block. |
| `src/EcwReader.js` | Thin class: level choice, block range, assembly, output sizing. |
| `src/workers/ecwDecodeWorker.js` | Message protocol `parse` / `progress` / `result` / `error`; typed arrays returned as transferables; cancel via `terminate()`. |
| `src/errors.js` | `EcwError` with a `code` and the byte offset where relevant. |
| `src/index.js` | Public exports. |

Every source file opens with a `// src/path/File.js` line and a banner (purpose, rationale, `FINDINGS.md` reference), uses `var`, tabs and function declarations, and carries JSDoc on exports. Constants are named with hex values (`HEADER_WIDTH_OFFSET = 0x06`). Error messages name the offset.

## 6. Data flow — `readRegion`

1. **Choose level:** the coarsest level whose resolution is still at least `outWidth / width`.
2. **Block range:** map the window onto that level's 64×64 grid; look up each block's byte range in the index.
3. **Per block:** cache hit → read from OPFS; miss → `BlobSource.read` the compressed bytes and decode.
   If levels refine one another, decoding walks up from the coarsest level and the cache keeps intermediate levels.
4. **Assemble:** colour-convert, crop, resample to `outWidth × outHeight`, apply the optional `transparentBelow` and `clipPolygon` steps, write into the output buffer (memory) or stream rows to an OPFS sync writer (`readRegionToScratch`).
5. **Fingerprint** for cache keys: file name, size, `lastModified`, and a hash of the first 4 KB.

The main-thread `EcwReader` forwards calls to the Worker; the `File` is structured-cloned into the Worker without copying its bytes.

## 7. Known facts (from bytes, confirmed by `gdalinfo`)

Evidence comes from a private RGB ECW v2 orthophoto. Its details stay out of the repo; sample tests read expected values from `samples/ref/gdalinfo.json` at runtime.

| Offset | Type | Meaning | Status |
|---|---|---|---|
| `0x00` | u8 `0x65` | Signature byte | hypothesis (one sample) |
| `0x01` | u8 `2` | Format version (gdalinfo `VERSION=2`) | likely |
| `0x02`–`0x03` | `01 02` | Unknown | open |
| `0x04` | u8 `10` | Level-record count | ✅ (table below has exactly 10) |
| `0x05` | u8 `4` | Unknown | open |
| `0x06` | u32 BE | Width | ✅ |
| `0x0A` | u32 BE | Height | ✅ |
| `0x0E` | u16 BE | Bands | ✅ |
| `0x10` | u16 BE `1` | Unknown | open |
| `0x12` / `0x14` | u16 BE `64`, `64` | Block width / height | likely |
| `0x16` | u16 BE `8` | Compression target (gdalinfo `COMPRESSION_RATE_TARGET=8`) | likely |
| `0x18` | u8 `1` | Georeferencing-present flag | hypothesis |
| `0x19` / `0x21` | f64 LE | Cell size X / Y (Y negative, north-up) | ✅ |
| `0x29` / `0x31` | f64 LE | Origin X / Y (top-left corner) | ✅ |
| `0x39`–`0x48` | 16 bytes ASCII, NUL-padded | Datum name | likely |
| `0x49`–`0x58` | 16 bytes ASCII, NUL-padded | Projection name | likely |
| `0x59` | `levelCount` × 21-byte records | Level table: u8 level, u32 BE width, u32 BE height, three u32 BE `a`, `b`, `c` | ✅ layout; `a/b/c` meaning open |
| after table | `00 'R' 'M' 09 01 …` | Unknown marker | open |
| `0x130`.. | rising u64 LE | Probable block offset table | hypothesis |

Level records run coarsest first. Level `k` of `n` has size `ceil(W / 2^(n-k))` × `ceil(H / 2^(n-k))`; full resolution is not a record.
On the sample, `a/b/c` stay at 1 for the coarsest levels, then grow with level.
GDAL reports floor-sized overviews and omits the coarsest stored level; its coarsest overview repeats every value in pairs, consistent with upsampling that level.
Mixed endianness: integers big-endian, doubles little-endian.

## 8. Reverse-engineering workflow

- **Probes:** Node `.mjs` scripts in `_dev/ecw-decode/`, reading slices with `fs.readSync` (safe on multi-GB files). Starter tools: `hexAnnotate.mjs` (annotated hex dump with rulers), `byteStats.mjs` (entropy / histogram per range), `compareRaster.mjs` (diff our output against a reference TIFF).
- **Hypothesis log:** `_dev/ecw-decode/FINDINGS.md` with a sample table, `⭐ CRACKED` / `⚠ SUPERSEDED` banners, "Ruled out (don't re-walk)" lists.
- **Format spec:** `docs/ECW_FORMAT_SPEC.md`, numbered sections, each fact marked with its evidence. Published with the repo.
- **Ground truth:** QGIS 4.2.3 bundled GDAL at `C:\Program Files\QGIS 4.2.3\bin` (`gdalinfo -json`, `gdal_translate`). Reference set, all in `samples/ref/`:
  - `gdalinfo.json`
  - one uncompressed GeoTIFF per stored level, aligned to whole level cells (`-srcwin` + `-outsize`), starting with the coarsest;
  - full-resolution crops (`-srcwin`): 256×256 at (0,0); 512×512 aligned to the 64-px grid mid-image; 300×300 straddling block edges at an odd offset.
- **Promotion rule:** a fact moves from probe to `src/` only via a failing test that encodes it.

## 9. Phases

One commit per phase; each updates `FINDINGS.md` and adds tests.

| Phase | Goal | Done when |
|---|---|---|
| 0 | Package scaffold, source contract, `MemorySource`, `BlobSource`, test harness, probes, `.gitignore`, reference set generated | `npm test` green on synthetic buffers; refs exist in `samples/ref/` |
| 1 | `EcwHeader` | Every field equals `gdalinfo.json` |
| 2 | `EcwLevels` + `EcwBlockIndex` | Offsets strictly rise; last block ends at file size (or a documented trailer); block counts equal `ceil(w/64)·ceil(h/64)` per level |
| 3 | Block internals | Band layout, sub-stream sizes and entropy-coder family documented in `FINDINGS.md` and spec |
| 4 | Decode the coarsest stored level | Exact match with that level's reference |
| 5 | Refine up to full resolution | Exact match with every level reference and all three crops |
| 6 | `ScratchBinaryFile`, `BlockCache`, `applyTransparency`, `clipToPolygon`, Worker, `EcwReader`, public API, `examples/browser/` demo | Browser region reads match references; scratch cleaned on success, error, abort |

**Pass criterion:** exact pixel match. ±1 allowed only once the rounding cause is understood and recorded.

**Risk:** phases 3–5 carry the uncertainty (entropy coder and wavelet). Phases 0–2 are near-certain and already deliver header + georeferencing reading.

## 10. Testing

- Test-first for all `src/` code (red → green → refactor), per the superpowers TDD skill.
- `test/` mirrors `src/` (`test/format/EcwHeader.test.js`, …). Files are `*.test.js`, using `node:test` and `node:assert/strict`.
- **Unit tests** use synthetic byte buffers built by small helpers in `test/helpers/` — no private data needed, so CI runs them all.
- **OPFS tests** use a mock `FileSystemSyncAccessHandle` with a tiny window size to force refills across window edges.
- **Sample tests** (`test/samples/*.test.js`) run against `samples/` and skip (`t.skip`) with a clear message when files are missing.
- **Parity tests** compare decoded pixels against `samples/ref/` TIFFs via a minimal in-repo uncompressed-TIFF reader in `test/helpers/` (test-only, not shipped).
- Post-decode steps: threshold boundaries (N and N+1), one band above N keeps the pixel opaque; polygon edges through pixel centres, concave shapes, holes, rings outside the window, self-touching rings, empty ring list (no-op), and both options combined.
- Edge cases: windows at image edges, partial edge blocks, 1×1 windows, `outWidth` upscaling vs downscaling, aborts mid-decode, truncated files, corrupt offsets (each must raise a specific `EcwError` code).
- Target: every exported function has direct tests; `node --test --experimental-test-coverage` reported in CI.

## 11. Packaging (npm)

- `package.json`: `"type": "module"`, `"exports"` (`.` → `src/index.js`, `./worker` → `src/workers/ecwDecodeWorker.js`), `"files": ["src", "README.md", "LICENSE", "CHANGELOG.md"]`, `"sideEffects": false`, `"engines": { "node": ">=22" }`, zero `dependencies` and `devDependencies`.
- Scripts: `test` → `node --test`, `test:coverage`, `probe` helpers.
- Types: JSDoc only in v1 (no TypeScript toolchain).
- `README.md` (install, API, browser + Worker usage, limits, clean-room statement), `CHANGELOG.md`, `docs/ECW_FORMAT_SPEC.md`.
- GitHub Actions: `node --test` on Node 22 and 24 (Node 20 is end-of-life; test-file globs need 21+). Publishing is manual (`npm publish`) after the pre-publish checks.
- Versioning: `0.x` until full-resolution parity; `1.0.0` after.

## 12. Data hygiene

- `samples/` gitignored; `.npmignore` not needed because `files` whitelists.
- No sample imagery, coordinates or crops in tests, docs or commits; synthetic fixtures only.
- Clean-room statement in README: decoded from file bytes and black-box reference output; no SDK source consulted.
- Pre-publish checks are tracked privately; first `npm publish` waits on them.

## 13. Open questions

- None blocking. Package name `ecw-js` can change before first publish.
