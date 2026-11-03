# Enhanced-Compression-Wavelet-js

A JavaScript reader for ERDAS ECW (Enhanced Compression Wavelet) raster files, published on npm as `ecw-js`. Plain ES modules, no dependencies, runs in the browser and in Node.

**Status: early (0.x).** It works and is tested, but the API may still change before 1.0.

- Working: `openEcw` reads the header, georeferencing and levels; `readRegion` decodes imagery at any resolution; `readRegionToScratch` streams outputs too big for memory into OPFS.
- Accuracy: matches the ECW SDK (via GDAL) bit for bit on three independent test files, at full resolution and at every overview level.
- Also: a ready-made module Worker (`ecw-js/worker`).
- Stream modes decoded: 2, 5 and 6, each worked out from the bytes of real files. A file using any other mode raises `UNSUPPORTED_MODE` (see [Errors](#errors)).
- Not yet: writing ECW.
- Built clean-room: no ECW SDK source code was used. See [Clean-room build](#clean-room-build).

## Install

```sh
npm install ecw-js
```

Node 22 or newer, or any current browser. No dependencies.

## Demo

Try it in the browser: **https://brentbuffham.github.io/Enhanced-Compression-Wavelet-js/**

Drop an ECW file onto the page. It shows the header, georeferencing, a map of compressed block sizes, stream statistics, and lets you run every library function from a side panel. Your file is read locally and never uploaded. To run it locally: `npm run demo`, then open http://localhost:8080/.

## Why

ECW is a common format for large orthophotos, and the only way to read it so far has been Hexagon's ECW SDK, either directly or through GDAL. There's no open decoder you can drop into a web page. This is an attempt at one.

## Clean-room build

This library was written under clean-room rules. The format was worked out from the outside, the same way you'd reverse-engineer any undocumented binary.

The rules followed:

- **No SDK source.** No ECW SDK source code (libecw, Hexagon or ERDAS) was read, copied, translated or used as a reference.
- **File bytes only.** The layout was worked out by reading the bytes of real ECW files.
- **Black-box comparison.** Decoded output was checked against GDAL's output for the same window, with GDAL and the ECW SDK used purely as a black box: files in, pixels out.
- **Constructed test files.** Where no real file was available, small ECW files were written with chosen values and the SDK was asked to decode them. Nothing inside the SDK was inspected.
- **Public documentation only.** GDAL's published ECW driver documentation was consulted. No confidential material was used.
- **No SDK code shipped or linked.** ecw-js is plain JavaScript with no dependencies. It doesn't call, bundle or need the ECW SDK, and no encoder licence was bypassed.
- **Private data stays private.** The sample files used for testing aren't published, and nothing in this repository is derived from their content.

Everything worked out this way is written up as a plain-English format spec in [`docs/ECW_FORMAT_SPEC.md`](docs/ECW_FORMAT_SPEC.md), along with what is still unknown.

## Reading the header

```js
import { openEcw } from "ecw-js";

var ecw = await openEcw(file); // a File or Blob; only the first 8 KB is read

ecw.info;
// { version, width, height, bands, blockWidth, blockHeight, compressionTarget,
//   levels: [{ width, height }, ...],  // coarsest first, full resolution last
//   cellSizeX, cellSizeY, originX, originY, datum, projection, units }
```

`originX` / `originY` is the top-left corner. `cellSizeY` is negative for north-up images. Georeferencing values are returned exactly as stored, so a value can sit one unit in the last place away from the tidied number GDAL shows.

`pixelWindowToBounds(ecw.info, x, y, width, height)` turns a pixel window into map-coordinate bounds.

### World file and .prj sidecars

The header only names the datum and projection (`GDA94`, `UTM55`, ...) and leaves `units` as `null`. If the ECW came with a world file (`.eww`, `.ecww` or `.wld`) and a `.prj`, pass them in as text or as Files:

```js
import { openEcw, pickSidecars } from "ecw-js";

var { worldFile, prj } = pickSidecars(ecwFile, droppedFiles); // matches site.ecw to site.eww / site.prj
var ecw = await openEcw(ecwFile, { worldFile, prj });

ecw.info.crs;          // { wkt, type, name, datum, projection, units, unitFactor, epsg } from the .prj
ecw.info.units;        // the .prj's linear unit, e.g. "Meter"
ecw.info.worldFile;    // { cellSizeX, cellSizeY, rotationX, rotationY, centreX, centreY, originX, originY }
ecw.info.warnings;     // where the world file disagrees with the header
ecw.info.georefSource; // "header"
```

The header stays the source of `originX`, `originY` and the cell sizes. A world file gives the centre of the top-left pixel, so its `originX` / `originY` (the corner) sit half a cell from `centreX` / `centreY`. When the two sources differ by more than a thousandth of a cell, `warnings` says by how much. Pass `georef: "worldFile"` to use the world file's georeferencing instead. Rotated world files aren't supported there.

`epsg` is filled in only when the WKT carries an EPSG authority. ESRI-style `.prj` files usually don't, and no names are mapped to codes. `parseWorldFile(text)` and `parsePrj(text)` are exported for use on their own.

## Reading pixels

```js
import { openEcw } from "ecw-js";

var ecw = await openEcw(file); // a File or Blob

ecw.info;
// { width, height, bands, blockWidth, blockHeight, levels,
//   cellSizeX, cellSizeY, originX, originY, datum, projection, ... }

var img = await ecw.readRegion({
	x: 0, y: 0, width: 4096, height: 4096, // full-resolution pixel window
	outWidth: 1024, outHeight: 1024,         // picks the right resolution level
	resample: "average",                     // optional: "nearest" (default, SDK-exact) or "average" (smooth)
	transparentBelow: 8,                     // optional: near-black becomes transparent (3 clears the flat background, 8 also the smeared footprint edge)
	transparentAbove: 250,                   // optional: near-white becomes transparent
	transparentColor: { color: "#3a5f2b", below: 6, above: 6 }, // optional: a colour ± tolerance (or a list of them)
	clipPolygon: [[[x1, y1], [x2, y2], [x3, y3]]], // optional: map-coordinate rings
	onBadBlock: "skip"                       // optional: read around blocks that can't be decoded (default "throw")
});
// { data: Uint8ClampedArray (RGBA), width, height, level, bounds: { minX, minY, maxX, maxY },
//   badBlocks }  // only with onBadBlock: "skip"

await ecw.close(); // also deletes this reader's scratch files
```

### Blocks that can't be decoded

By default a read stops at the first block it can't decode. It raises `BAD_BLOCK` for a damaged block, or `UNSUPPORTED_MODE` for a stream in a mode ecw-js doesn't decode yet. The error says which block it was (see [Errors](#errors)).

With `onBadBlock: "skip"`, the read carries on. Each stream that can't be decoded is read as empty, which means no detail from it, and a block whose stream table is broken is read with all its streams empty. The area renders softer rather than blank, and `badBlocks` lists what was skipped:

```js
img.badBlocks;
// [{ block, level, row, col, offset, code, mode?, message,
//    streams: [{ band, subband, mode, code }] }]   // streams is [] when the whole block was skipped
```

Show the user when `badBlocks` isn't empty: the picture isn't complete. Tiles built around skipped blocks are never cached, so a later read without `"skip"` still raises the error. `readRegionToScratch` takes the same option and returns `badBlocks` too.

## Showing it on screen

The pixels match GDAL exactly, but two things change how they look next to QGIS:

- **Resampling.** `resample: "nearest"` (the default) is what QGIS and GDAL do and looks crisp. `"average"` is smoother and softer. Ask for the size you'll draw at, and draw it pixel for pixel: scaling the result again on a canvas blurs it.
- **Colour on wide-gamut screens.** Browsers colour-manage canvas pixels as sRGB, so on a Display P3 monitor they look duller than in QGIS, which sends the raw values to the screen. To match QGIS, tag the pixels as Display P3 so the browser leaves them alone:

```js
var ctx = canvas.getContext("2d", { colorSpace: "display-p3" });
ctx.putImageData(new ImageData(img.data, img.width, img.height, { colorSpace: "display-p3" }), 0, 0);
```

Imagery stored with low contrast can also be stretched, the way QGIS's min/max stretch does. It's off by default; compute it once per file so every read matches:

```js
var stretch = await ecw.computeStretch({ cut: [2, 98] }); // { min: [r, g, b], max: [r, g, b] }
var img = await ecw.readRegion({ x, y, width, height, stretch });
```

## Outputs bigger than memory

`readRegion` refuses outputs above `maxOutputBytes` (512 MB by default) with `OUTPUT_TOO_LARGE`. For those, `readRegionToScratch` takes the same options, decodes in strips and streams the RGBA rows into a scratch file in the browser's Origin Private File System (OPFS). It needs synchronous OPFS access, so call it from a Worker.

```js
var out = await ecw.readRegionToScratch({ x: 0, y: 0, width: 120000, height: 80000, outWidth: 30000, outHeight: 20000 });
// { scratchId, width, height, level, bounds, byteLength, openReader() }
var reader = await out.openReader();
var firstRow = reader.slice(0, out.width * 4); // RGBA rows, top to bottom
reader.close();
```

The bytes are exactly what `readRegion` would have returned. Scratch files are removed by `ecw.close()`; call `sweepStaleScratchFiles()` at startup to clear any left behind by a crashed tab (older than 24 hours by default).

## Caching

Wavelet synthesis is most of the decode time, so a reader keeps the reconstructed tiles of every level it builds and reuses them. A repeated view or a pan comes back several times faster, and zooming in reuses the coarser level it already built.

```js
import { openEcw, blockCacheUsage, clearBlockCache } from "ecw-js";

var ecw = await openEcw(file);                                   // memory cache, 256 MB (default)
var ecw = await openEcw(file, { cache: { opfs: true } });        // also keep tiles in OPFS for later visits
var ecw = await openEcw(file, { cache: { memoryBytes: 64 * 1024 * 1024, opfs: { maxBytes: 1024 * 1024 * 1024 } } });
var ecw = await openEcw(file, { cache: false });                 // no caching

ecw.cacheStats();          // { memoryTiles, memoryBytes, hits, misses, opfsHits }
await blockCacheUsage();   // [{ fingerprint, tiles, bytes }] per file in OPFS
await clearBlockCache();   // delete every cached tile
```

The OPFS tier is keyed by a fingerprint of the file (name, size, date, first 4 KB) and the decoder version, so an edited file or a newer ecw-js never reuses stale tiles. Tiles are written in packs of about 8 MB and the oldest packs go first once `maxBytes` (512 MB by default) is reached. Output is byte for byte the same with or without a cache.

## Several cores

Large reads are split into bands of output rows and decoded on a pool of workers, one band each. The output is byte for byte the same as one thread's, and the GDAL parity tests run both ways.

```js
var ecw = await openEcw(file);                  // automatic (default)
var ecw = await openEcw(file, { threads: 1 });  // this thread only
var ecw = await openEcw(file, { threads: 4 });  // 4 workers for every read
```

- **Automatic is the default.** Callers that don't pass `threads`, including an `open` message to `ecw-js/worker` or `createWorkerHandler` without it, get the pool from 0.3.0 on. Pass `threads: 1` to keep 0.2 behaviour.
- **Automatic** uses up to 4 workers (one fewer than the cores) for reads of 1 megapixel or more. It never waits for them: the first large read runs on this thread while the pool starts, and later reads use the pool. With `cache: { opfs: true }` it stays on this thread, because the OPFS tile cache lives there.
- **`threads: n`** starts `n` workers on the first read and waits for them. Each worker keeps its own memory cache, an equal share of `memoryBytes`; the OPFS tier isn't used by pooled reads.
- The pool belongs to the reader. It closes after 30 seconds without use (the next large read starts it again) and on `ecw.close()`. Each open reader has its own pool, so with several files open, pass `threads` to control the total.
- If workers can't start, reads carry on on this thread. If a worker dies mid-read, that read fails with `WORKER_FAILED` and later reads use this thread.
- In the browser, a `File` or `Blob` reaches the workers without being copied, and the pool can be started from inside another Worker. In Node, a Blob from `fs.openAsBlob` can't be posted to a worker, so reads of such a Blob stay on this thread; a Blob made from bytes in memory works.
- On a 4096 × 4096 full-resolution read in Chrome, 4 workers took about 0.9 s against 2.0 s on one thread.

Bundlers: the pool starts `src/workers/decodePoolWorker.js` with `new Worker(new URL(...), import.meta.url)`, which Vite, Rollup and webpack 5 follow. With Vite, add `ecw-js` to `optimizeDeps.exclude` so the worker file stays next to the module that loads it.

## In a Worker

Decoding big regions takes a while, so keep it off the main thread. `ecw-js/worker` is a module Worker that speaks a small message protocol: send `{ id, type, payload }`, get back `progress` messages and then one `result` or `error` with the same `id`.

```js
var worker = new Worker(new URL("ecw-js/worker", import.meta.url), { type: "module" });
worker.onmessage = function (event) {
	var msg = event.data; // { id, type: "progress", fraction, label } | { id, type: "result", result } | { id, type: "error", code, message }
};
worker.postMessage({ id: 1, type: "open", payload: { blob: file } });            // result: ecw.info; add cache and threads as in openEcw
worker.postMessage({ id: 2, type: "readRegion", payload: { x: 0, y: 0, width: 4096, height: 4096, outWidth: 1024, outHeight: 1024 } });
worker.postMessage({ id: 3, type: "readRegionToScratch", payload: { /* same options */ } }); // result: { scratchId, byteLength, ... }
worker.postMessage({ id: 4, type: "abort", payload: { id: 2 } });                 // job 2 ends with error code ABORTED
worker.postMessage({ id: 5, type: "close" });
```

The file is structured-cloned into the Worker without copying its bytes, and pixel buffers come back transferred. Read a scratch result on the main thread with `getScratchFile(scratchId)`.

To install the handler yourself (your own Worker entry, or another host), import `createWorkerHandler` from `ecw-js/workerProtocol`: `createWorkerHandler(post)` returns the message handler and `post(msg, transfer)` sends replies.

A Worker holds one file at a time. Sending `open` or `close` aborts the reads still running on the current file (they end with `ABORTED`), waits for them, then closes it. Closing deletes that file's scratch results, so copy out what you need first. Each `id` must be unique among running jobs; a duplicate gets `INVALID_ARGUMENT`.

## Errors

Everything throws or rejects with an `EcwError`. Branch on `error.code`; `error.offset` is the file offset where the problem was found, when there is one. An error from one block also has `error.block`: `{ number, level, row, col, offset }`, where `level` is the level-record index (0 = coarsest) and `offset` is the block's file offset. The message starts with the same location.

| Code | Meaning |
|---|---|
| `NOT_ECW` | Not an ECW file (wrong signature, or zero width, height or bands) |
| `UNSUPPORTED_VERSION` | An ECW version other than 2 |
| `TRUNCATED` | The file ends before the data it describes |
| `BAD_LEVEL_TABLE` | The resolution-level table is inconsistent |
| `BAD_BLOCK_INDEX` | The block index is inconsistent (wrong length, falling offsets, wrong entry count) |
| `BAD_BLOCK` | A block is damaged: its stream table is inconsistent, or a stream doesn't decode to the block's size |
| `UNSUPPORTED_MODE` | A stream uses a mode ecw-js doesn't decode yet. `error.mode` is the mode byte read. The file isn't necessarily damaged. The message asks for an ECW that uses the mode, sent to blastingapps.com, so it can be added clean-room. |
| `INVALID_ARGUMENT` | A bad argument, such as a non-Blob or a reversed range, or a read on a closed reader |
| `OUTPUT_TOO_LARGE` | A region read would exceed the in-memory limit |
| `ABORTED` | The read was cancelled with an `AbortSignal` |
| `NOT_IMPLEMENTED` | A feature that isn't available yet: currently only `georef: "worldFile"` with a rotated world file |
| `WORKER_FAILED` | A decode worker stopped in the middle of a read; later reads run on this thread |

## Scope

In: reading ECW version 2 files, georeferencing, region reads at any resolution level, optional transparency and polygon clipping.

Out, for now: JPEG 2000, writing ECW, and ECWP network streaming.

## Development

Needs Node 22 or later. No install step, there are no dependencies.

```sh
npm test
```

Tests use synthetic byte buffers, so they run anywhere. Tests against real ECW files look in a local `samples/` folder, which is gitignored, and skip if it's empty.

### Running sample tests

1. Put an `.ecw` file in `samples/`.
2. Install QGIS (its Windows build includes GDAL with ECW read support).
3. Build the reference set: `node _dev/ecw-decode/makeRefs.mjs samples/<file>.ecw`. Set `QGIS_BIN` if QGIS is not in `C:\Program Files\QGIS 4.2.3\bin`.
4. Run `npm test`. The sample tests now run instead of skipping.

## Licence

MIT. See [LICENSE](LICENSE).

Not affiliated with or endorsed by Hexagon or ERDAS.

Brent Buffham, [blastingapps.com](https://blastingapps.com) and [kirra-design.com](https://kirra-design.com)
