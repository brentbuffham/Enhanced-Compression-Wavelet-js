# ecw-js demo

Drop an ECW file onto the page to see the library at work. Files are read locally in a Worker and never uploaded.

## Run it

- Locally: `npm run demo`, then open http://localhost:8080/
- Online: https://brentbuffham.github.io/Enhanced-Compression-Wavelet-js/

## What each tab does

- **Info**: `openEcw` and `pixelWindowToBounds`. Header, georeferencing, levels.
- **Blocks**: `parseBlockIndex`, `blockGrid`, `levelEntryWindow`, `blockByteRange`, `splitBlockStreams`. A block-size map per level, hover to inspect a block's streams, and stream-mode sampling.
- **Clip**: `clipToPolygon` and `applyTransparency` on the current picture.
- **Read**: `readRegion` in the Worker. Opening a file decodes a whole-image view at screen size; any window can be decoded at any output size. "Whole image" refills the form.
- **Scratch**: `listScratchFiles`, `getScratchFile`, `removeScratchFile`, `sweepStaleScratchFiles`. Browser storage (OPFS) used, kept files, scratch files.

Tick **Keep in browser** to copy an opened file into OPFS (in the Worker, with `openScratchSyncWriter`). Kept files live in `ecw-kept`, outside the 24-hour scratch sweep, and reopen from the Scratch tab after a reload.

Each tab writes the call it made, and its result, into "How it works".

## Manual checklist

1. Open the page. The empty viewer says "Drop an ECW file here" and the panel shows four tabs.
2. Drop an ECW file. The progress bar runs, the status bar fills with size, bands, levels, blocks, ratio and file size, and the decoded image appears.
3. Info tab: every field is filled and the levels table ends with a "full" row.
4. Blocks tab: change the level. The block-size map replaces the image and the level stats update.
5. Hover over the map. The HUD shows map coordinates and the block number, and the panel lists the block's streams with modes.
6. Click "Sample stream modes". Mode counts and the empty-stream share appear, and the status bar gains an "empty streams" figure.
7. Mouse wheel zooms around the cursor; drag pans.
8. Clip tab: click "Draw polygon", click three or more points, double-click to finish, then "Apply". Pixels outside the polygon and below the threshold turn transparent (checkerboard shows). "Reset picture" restores the map.
9. After a drop, the decoded image appears and the status bar says which level it came from and how long it took. Read tab: set a 1024×1024 window at full resolution and run it; the viewer shows the detail.
10. Drop a non-ECW file (for example a PNG). The status bar shows `NOT_ECW` and the next ECW drop works.
11. Toggle the panel with ☰. The viewer refits.
12. Tick "Keep in browser" and drop a file. The status bar ends with "kept … in browser storage" and the Scratch tab lists it with storage used.
13. Reload the page, open the Scratch tab, click "open" on the kept file. It opens without a drop. "delete" removes it.
