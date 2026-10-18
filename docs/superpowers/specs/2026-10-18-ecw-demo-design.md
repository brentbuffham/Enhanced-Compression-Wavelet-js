# ECW Demo Page — Design Spec

- **Status:** Approved in chat 2026-10-18
- **Parent spec:** `2026-10-18-ecw-decoder-design.md`

## 1. Intent

A browser demo that shows ecw-js at work and how it works: drop an ECW file, watch it read with a progress bar, see statistics and a picture of the file, and drive every public library function from a side panel. It doubles as the reverse-engineering workbench until pixel decoding lands, then shows decoded imagery. Every library Brent builds gets a demo page like this.

## 2. Ground rules

- Vanilla HTML, CSS and JS ES modules; zero dependencies.
- Lives in `examples/browser/`; never in the npm package (`files` whitelist already excludes it).
- Imports the library from `../../src/index.js`, so it always runs the current code.
- Heavy work runs in a module Worker so the page stays responsive on multi-GB files.
- Dropped files never leave the browser; the page says so.

## 3. Hosting

- Local: `npm run demo` → `_dev/serve.mjs`, zero-dependency static server on `http://localhost:8080/` (secure context, so OPFS and Workers work). Root redirects to `/examples/browser/`. Refuses paths outside the repo.
- Public: GitHub Pages, deployed by `.github/workflows/pages.yml` on push to `main`; the artifact is the repo's `src/`, `examples/` and a root `index.html` redirect.

## 4. Layout

Viewer fills the page; collapsible panel on the right with one tab per function group; status bar along the bottom with the progress bar and headline stats (size, bands, levels, compression ratio, share of empty streams, block count). Light and dark follow `prefers-color-scheme`.

## 5. Tabs

| Tab | Library calls | Shows |
|---|---|---|
| Info | `openEcw`, `pixelWindowToBounds` | Every `info` field, map bounds |
| Blocks | `parseBlockIndex`, `blockGrid`, `blockByteRange`, `splitBlockStreams` | Level picker; block-size map (one pixel per block, log-scaled colour); hover → block number, byte range, stream modes; per-level stats (bytes, bytes/block, sampled mode counts) |
| Clip | `clipToPolygon`, `applyTransparency` | Draw a polygon on the viewer (click to add, double-click to close); apply to the current picture |
| Read | `readRegion` | Full form; until the codec lands it shows the `NOT_IMPLEMENTED` error |
| Writer (later) | encoder | GeoTIFF → ECW export, added in the writer phase |

Every tab has a "How it works" box showing the exact call it made and a summary of the result.

## 6. Library changes

`src/index.js` additionally exports `applyTransparency`, `clipToPolygon` and the Plan 2 block functions (`parseBlockIndex`, `blockGrid`, `blockByteRange`, `blockEntryWindow`, `splitBlockStreams`, `STREAM_MODE`).

## 7. Order

Plan 2 Tasks 1–3 (block index, framing, sample parity) → this demo → Plan 2 Tasks 4–6 (codec research, using the demo as workbench).

## 8. Testing

- Pure helpers in `examples/browser/lib/` and the worker core are test-first with `node --test`.
- `_dev/serve.mjs`: MIME types, root redirect, path traversal refused.
- UI: manual numbered checklist in the README.

## 9. Future: ECW writer

Load a GeoTIFF (needs a TIFF reader with Deflate/LZW; browsers decode Deflate natively) and export ECW that GDAL can read. A separate spec once the decoder is complete. Pre-publish checks for a writer are tracked privately.
