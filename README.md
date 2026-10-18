# Enhanced-Compression-Wavelet-js

A JavaScript reader for ERDAS ECW (Enhanced Compression Wavelet) raster files, published on npm as `ecw-js`. Plain ES modules, no dependencies, runs in the browser and in Node.

**Status: work in progress.** Nothing is published to npm yet and the API may change.

- Working: `openEcw` reads the header, georeferencing and levels; `readRegion` decodes imagery at any resolution; `readRegionToScratch` streams outputs too big for memory into OPFS.
- Accuracy: matches the ECW SDK (via GDAL) bit for bit on two independent test files, at full resolution and at every overview level.
- Also: a ready-made module Worker (`ecw-js/worker`).
- Not yet: writing ECW.

## Demo

Try it in the browser: **https://brentbuffham.github.io/Enhanced-Compression-Wavelet-js/**

Drop an ECW file onto the page. It shows the header, georeferencing, a map of compressed block sizes, stream statistics, and lets you run every library function from a side panel. Your file is read locally and never uploaded. To run it locally: `npm run demo`, then open http://localhost:8080/.

## Why

ECW is a common format for large orthophotos, and the only way to read it so far has been Hexagon's ECW SDK, either directly or through GDAL. There's no open decoder you can drop into a web page. This is an attempt at one.

## How it's being built

The format is being worked out from the bytes of real ECW files, the same way you'd reverse-engineer any undocumented binary. Each decoded output is checked against GDAL's output for the same window, using GDAL purely as a black box.

No ECW SDK source code (libecw or Hexagon) is read, copied or translated. The findings are written up as a plain-English format spec in `docs/` as they're confirmed.

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
	transparentBelow: 3,                     // optional: near-black becomes transparent
	clipPolygon: [[[x1, y1], [x2, y2], [x3, y3]]] // optional: map-coordinate rings
});
// { data: Uint8ClampedArray (RGBA), width, height, level, bounds: { minX, minY, maxX, maxY } }

await ecw.close(); // also deletes this reader's scratch files
```

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

## In a Worker

Decoding big regions takes a while, so keep it off the main thread. `ecw-js/worker` is a module Worker that speaks a small message protocol: send `{ id, type, payload }`, get back `progress` messages and then one `result` or `error` with the same `id`.

```js
var worker = new Worker(new URL("ecw-js/worker", import.meta.url), { type: "module" });
worker.onmessage = function (event) {
	var msg = event.data; // { id, type: "progress", fraction, label } | { id, type: "result", result } | { id, type: "error", code, message }
};
worker.postMessage({ id: 1, type: "open", payload: { blob: file } });            // result: ecw.info
worker.postMessage({ id: 2, type: "readRegion", payload: { x: 0, y: 0, width: 4096, height: 4096, outWidth: 1024, outHeight: 1024 } });
worker.postMessage({ id: 3, type: "readRegionToScratch", payload: { /* same options */ } }); // result: { scratchId, byteLength, ... }
worker.postMessage({ id: 4, type: "abort", payload: { id: 2 } });                 // job 2 ends with error code ABORTED
worker.postMessage({ id: 5, type: "close" });
```

The file is structured-cloned into the Worker without copying its bytes, and pixel buffers come back transferred. Read a scratch result on the main thread with `getScratchFile(scratchId)`.

## Errors

Everything throws or rejects with an `EcwError`. Branch on `error.code`; `error.offset` is the byte offset where the problem was found, when there is one.

| Code | Meaning |
|---|---|
| `NOT_ECW` | Not an ECW file (wrong signature, or zero width, height or bands) |
| `UNSUPPORTED_VERSION` | An ECW version other than 2 |
| `TRUNCATED` | The file ends before the data it describes |
| `BAD_LEVEL_TABLE` | The resolution-level table is inconsistent |
| `BAD_BLOCK_INDEX` | The block index is inconsistent (wrong length, falling offsets, wrong entry count) |
| `BAD_BLOCK` | A block's internal stream table is inconsistent |
| `INVALID_ARGUMENT` | A bad argument, such as a non-Blob or a reversed range |
| `OUTPUT_TOO_LARGE` | A region read would exceed the in-memory limit |
| `ABORTED` | The read was cancelled with an `AbortSignal` |
| `NOT_IMPLEMENTED` | A feature that is not available yet (`readRegionToScratch`) |

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
