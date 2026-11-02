# ECW Worker Pool Plan (0.3.0)

**Goal:** Decode large reads on several cores. A read's output rows are split into bands and each band is decoded by a worker, so a full-resolution read finishes in a fraction of the single-thread time.

**Why bands of output rows:** `EcwReader._decodeRows(plan, oy0, oy1)` already decodes any band of output rows, and the sample suite proves band-by-band output (the `readRegionToScratch` strips) equals `readRegion` byte for byte. Splitting by rows keeps GDAL parity without new reconstruction code.

## Design

- `openEcw(blob, { threads })`: `0` or unset = automatic, `1` = this thread only, `n` = `n` workers.
  - Automatic: cores − 1, at most 4 per reader, only for outputs of at least 1 megapixel, and not when the OPFS cache is on. It never waits: the first large read runs on this thread while the pool starts in the background (a cold pool cost more than a small read saved).
  - An explicit `n >= 2` always uses the pool and waits for it.
- The pool starts on the first read that needs it, closes after 30 s idle, and closes on `close()`. Each worker opens the same Blob itself (Blobs clone without copying), so only the decoded RGBA crosses back, transferred.
- Band `i` always goes to worker `i`, so a repeated or panned read finds its tiles in that worker's memory cache. Each worker's cache gets an equal share of `memoryBytes`; the OPFS tier stays with single-thread reads (several writers can't share its pack files).
- Workers: browser module Workers or Node `worker_threads`, one entry (`src/workers/decodePoolWorker.js`). The message handling lives in `createPoolWorkerHandler(post)` so tests drive it without threads.
- Start-up: each worker says it is ready, then opens the file. If any worker fails to start or open, the reader decodes on its own thread from then on.
- Node: idle workers are unreferenced, so a reader that is never closed doesn't keep the process alive.
- Abort: the read's signal posts an abort to every band's worker; the read rejects `ABORTED`. One band failing aborts the others.
- Progress: band fractions weighted by rows, as one bar.
- `readRegionToScratch` strips go through the same path.
- `ecw-js/worker` passes `threads` from `open`.

## Tests

- Pool handler in process: open, rows, progress, abort, errors.
- Real workers: `threads: 2` output equals `threads: 1` for nearest, average, transparency, clip and stretch; scratch strips the same; abort; a worker that can't start falls back; `close()` ends the workers.
- Private samples: `threads: 2` equals the GDAL references exactly.

## Demo

A Threads control and the decode time of each read, so single and pooled reads can be compared on a real file.
