# Enhanced-Compression-Wavelet-js

A JavaScript reader for ERDAS ECW (Enhanced Compression Wavelet) raster files, published on npm as `ecw-js`. Plain ES modules, no dependencies, runs in the browser and in Node.

**Status: work in progress.** Nothing is published to npm yet and the API below may change. Header and georeferencing reading comes first; pixel decoding follows once the block format is worked out.

## Why

ECW is a common format for large orthophotos, and the only way to read it so far has been Hexagon's ECW SDK, either directly or through GDAL. There's no open decoder you can drop into a web page. This is an attempt at one.

## How it's being built

The format is being worked out from the bytes of real ECW files, the same way you'd reverse-engineer any undocumented binary. Each decoded output is checked against GDAL's output for the same window, using GDAL purely as a black box.

No ECW SDK source code (libecw or Hexagon) is read, copied or translated. The findings are written up as a plain-English format spec in `docs/` as they're confirmed.

## Planned API

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
