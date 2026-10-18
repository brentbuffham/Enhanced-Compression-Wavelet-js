# Changelog

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
