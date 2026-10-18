# Enhanced-Compression-Wavelet-js

A JavaScript reader for ERDAS ECW (Enhanced Compression Wavelet) raster files, published on npm as `ecw-js`. Plain ES modules, no dependencies, runs in the browser and in Node.

**Status: work in progress.** Nothing is published to npm yet and the API may change.

- Working: `openEcw` reads the header, georeferencing and resolution levels.
- Not yet: pixel decoding. `readRegion` rejects with `NOT_IMPLEMENTED` until the block format is worked out.

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

## Planned pixel API

```js
import { openEcw } from "ecw-js";

var ecw = await openEcw(file); // a File or Blob

ecw.info;
// { width, height, bands, blockWidth, blockHeight, levels,
//   cellSizeX, cellSizeY, originX, originY, datum, projection, ... }

var img = await ecw.readRegion({
	x: 0, y: 0, width: 4096, height: 4096, // full-resolution pixel window
	outWidth: 1024, outHeight: 1024,         // picks the right resolution level
	transparentBelow: 3,                     // optional: near-black becomes transparent
	clipPolygon: [[[x1, y1], [x2, y2], [x3, y3]]] // optional: map-coordinate rings
});
// { data: Uint8ClampedArray (RGBA), width, height, bounds: { minX, minY, maxX, maxY } }

ecw.close();
```

Big outputs go to a scratch file in the browser's Origin Private File System (OPFS) rather than memory, and decoded blocks are cached there too.

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
| `NOT_IMPLEMENTED` | Pixel decoding is not available yet |

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
