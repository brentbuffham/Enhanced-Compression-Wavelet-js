# ECW Foundation Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a tested, zero-dependency npm package that reads ECW header, georeferencing and level table, plus the codec-independent pieces (byte sources, OPFS scratch, transparency, polygon clip, reference tooling), and end with the block offset table researched and documented.

**Architecture:** Pure, DOM-free layers (io → format → post) over a sync byte-source contract; an async `BlobSource` reads ranges from a `File` which are parsed through `MemorySource`. Reverse-engineering probes live in `_dev/ecw-decode/` beside a `FINDINGS.md` log; facts move into `src/` only through a failing test. Plan 2 (written after Task 13) covers the block index, the wavelet codec, `BlockCache`, the Worker and `readRegion`.

**Tech Stack:** Vanilla JavaScript ES modules, Node ≥ 22 built-in test runner (`node:test`, `node:assert/strict`), OPFS (`FileSystemSyncAccessHandle`), QGIS 4.2.3 bundled GDAL (ECW SDK 5.5) as black-box ground truth.

**Spec:** `docs/superpowers/specs/2026-10-18-ecw-decoder-design.md`

## Global Constraints

- Zero `dependencies` and zero `devDependencies`; no build step; no TypeScript.
- `"type": "module"`, `"engines": { "node": ">=22" }`, `"sideEffects": false`, `"files": ["src", "README.md", "LICENSE", "CHANGELOG.md"]`.
- Tests: `node --test "test/**/*.test.js"`; files named `*.test.js`, mirroring `src/` under `test/`.
- Test-first for every `src/` behaviour (superpowers `test-driven-development`): watch the test fail before writing code.
- No completion claim without running `npm test` and showing its output (superpowers `verification-before-completion`).
- Style: `var`, tabs, function declarations (constructor + prototype instead of `class`, except `EcwError extends Error`), JSDoc on every export, each file opens with `// src/path/File.js` and a `//=====` banner (purpose, rationale, `FINDINGS.md` reference). Hex-named constants (`HEADER_WIDTH_OFFSET = 0x06`). Error messages name the offset.
- 64-bit values built as `hi * 4294967296 + lo`, never `<<`; return `null` above `Number.MAX_SAFE_INTEGER`.
- Private data never enters git: `samples/` is gitignored; tests, docs and commits use synthetic values only. Sample tests read expected values from `samples/ref/gdalinfo.json` at runtime and `t.skip()` when files are missing.
- Commit after every task, to `main`, message ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Files over 4 GB** — u64 offsets and sizes ≥ 2^32 must read exactly; above 2^53 return `null`, never a wrong number. Pinned in Task 2.
2. **Wrong or partial input** (a `.jp2`, a PNG, a truncated download) — must raise `EcwError` with `NOT_ECW` / `TRUNCATED` and the offset, never a bare `RangeError`. Pinned in Tasks 2, 5, 6, 9.
3. **Corrupt level table** (count 0, out-of-order level bytes, a level larger than full size) — `BAD_LEVEL_TABLE` with the record offset. Pinned in Task 6.
4. **Clip on a scaled output** (`outWidth ≠ width`) — polygon tests must map each output pixel centre through `bounds`, not source pixels. Pinned in Task 11.
5. **Name fields with no NUL terminator** (exactly 16 ASCII chars) — return all 16 chars and stop; never read into the next field. Pinned in Tasks 2 and 5.

---

### Task 1: Package scaffold and test harness

**Files:**
- Already committed: `package.json` (0.0.1), `README.md`, `.gitignore`.
- Create: `.gitattributes`, `CHANGELOG.md`, `.github/workflows/test.yml`, `src/index.js`, `test/package.test.js`

**Interfaces:**
- Produces: `npm test` running `node --test "test/**/*.test.js"`; `npm run test:coverage` running the same with `--experimental-test-coverage`; `src/index.js` exporting `VERSION` (string, equals `package.json` version).

- [ ] **Step 1: Write the failing test** `test/package.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
var pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("package is a zero-dependency ES module", function () {
	assert.equal(pkg.name, "ecw-js");
	assert.equal(pkg.type, "module");
	assert.equal(pkg.license, "MIT");
	assert.equal(pkg.sideEffects, false);
	assert.deepEqual(pkg.engines, { node: ">=22" });
	assert.equal(pkg.dependencies, undefined);
	assert.equal(pkg.devDependencies, undefined);
	assert.deepEqual(pkg.files, ["src", "README.md", "LICENSE", "CHANGELOG.md"]);
	assert.equal(pkg.exports["."], "./src/index.js");
});

test("VERSION export matches package.json", async function () {
	var mod = await import("../src/index.js");
	assert.equal(mod.VERSION, pkg.version);
});
```

- [ ] **Step 2: Run** `node --test test/package.test.js` — Expected: FAIL (no `package.json`).
- [ ] **Step 3: Create the files.** `package.json` and `README.md` already exist (version `0.0.1`); keep them and add `"exports": { ".": "./src/index.js" }` (the `./worker` entry is added in Plan 2), scripts `test` and `test:coverage`, `repository` → `github:brentbuffham/Enhanced-Compression-Wavelet-js`. `.gitignore`: `samples/`, `node_modules/`, `coverage/`, `*.log`. `.gitattributes`: `* text=auto eol=lf`, `*.ecw binary`, `*.tif binary`. CI: `actions/checkout@v4`, `actions/setup-node@v4` matrix `[22, 24]`, run `npm test`. `CHANGELOG.md` with an `Unreleased` heading.
- [ ] **Step 4: Run** `npm test` — Expected: 2 passing.
- [ ] **Step 5: Commit** — `chore: package scaffold and node --test harness`

---

### Task 2: Errors, byte helpers and MemorySource

**Files:**
- Create: `src/errors.js`, `src/io/ByteSource.js`, `src/io/MemorySource.js`
- Test: `test/errors.test.js`, `test/io/ByteSource.test.js`, `test/io/MemorySource.test.js`

**Interfaces:**
- Produces:
  - `class EcwError extends Error` — `new EcwError(code, message, offset)`; `name === "EcwError"`, `code`, `offset` (number or `undefined`); message gets ` (at 0x<hex>)` appended when `offset` is a number.
  - `ERROR_CODES` frozen object: `NOT_ECW`, `UNSUPPORTED_VERSION`, `TRUNCATED`, `BAD_LEVEL_TABLE`, `INVALID_ARGUMENT`, `OUTPUT_TOO_LARGE`, `ABORTED`, `NOT_IMPLEMENTED`.
  - **Source contract** (any object with): `length() → number`, `slice(start, end) → Uint8Array`, `getUint8(pos)`, `getUint16(pos, le)`, `getUint32(pos, le)`, `getInt32(pos, le)`, `getFloat64(pos, le)`. Out-of-range reads throw `EcwError(TRUNCATED)` with the offending position.
  - `function MemorySource(bytes: Uint8Array)` (use with `new`), implementing the contract; `slice` returns a `subarray` view (callers must not mutate).
  - `readU64(source, pos, littleEndian) → number | null` and `readAscii(source, pos, maxLength) → string` (stops at first `0x00` or `maxLength`; bytes > 0x7E become `?`).

- [ ] **Step 1: Write failing tests**

```js
// test/errors.test.js
test("EcwError carries code and offset", function () {
	var e = new EcwError(ERROR_CODES.TRUNCATED, "need more bytes", 0x59);
	assert.ok(e instanceof Error);
	assert.equal(e.name, "EcwError");
	assert.equal(e.code, "TRUNCATED");
	assert.equal(e.offset, 0x59);
	assert.match(e.message, /\(at 0x59\)$/);
});
test("ERROR_CODES is frozen", function () { assert.ok(Object.isFrozen(ERROR_CODES)); });

// test/io/MemorySource.test.js
var src = new MemorySource(Uint8Array.from([0x00, 0x01, 0xEB, 0x1D, 0xFF, 0xFF, 0xFF, 0xFE]));
test("big- and little-endian integer getters", function () {
	assert.equal(src.length(), 8);
	assert.equal(src.getUint32(0, false), 0x0001EB1D);
	assert.equal(src.getUint16(2, true), 0x1DEB);
	assert.equal(src.getInt32(4, false), -2);
});
test("getFloat64 little-endian", function () {
	var b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, -0.15, true);
	assert.equal(new MemorySource(b).getFloat64(0, true), -0.15);
});
test("out-of-range read throws TRUNCATED with the position", function () {
	assert.throws(function () { src.getUint32(6, false); }, { code: "TRUNCATED", offset: 6 });
	assert.throws(function () { src.slice(4, 9); }, { code: "TRUNCATED", offset: 9 });
});
test("slice is a view of the requested range", function () {
	assert.deepEqual(Array.from(src.slice(1, 3)), [0x01, 0xEB]);
});

// test/io/ByteSource.test.js — build sources with DataView.setUint32
test("readU64 is exact above 2^32", function () { /* LE bytes 00 00 00 00 01 00 00 00 */ assert.equal(readU64(s1, 0, true), 4294967296); });
test("readU64 big-endian", function () { /* BE 00 00 00 02 00 00 00 05 */ assert.equal(readU64(s2, 0, false), 2 * 4294967296 + 5); });
test("readU64 returns null above MAX_SAFE_INTEGER", function () { /* LE ff×8 */ assert.equal(readU64(s3, 0, true), null); });
test("readU64 returns 2^53-1 exactly", function () { /* LE ff ff ff ff ff ff 1f 00 */ assert.equal(readU64(s4, 0, true), Number.MAX_SAFE_INTEGER); });
test("readAscii stops at NUL", function () { /* "GDA\0junk" */ assert.equal(readAscii(s5, 0, 16), "GDA"); });
test("readAscii with no NUL returns exactly maxLength chars", function () { /* "ABCDEFGHIJKLMNOPQ" */ assert.equal(readAscii(s6, 0, 16), "ABCDEFGHIJKLMNOP"); });
test("readAscii replaces non-ASCII bytes", function () { /* 41 C3 42 00 */ assert.equal(readAscii(s7, 0, 16), "A?B"); });
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the three modules. `MemorySource` wraps one `DataView` over `bytes.buffer, bytes.byteOffset, bytes.byteLength`; a private `check(pos, size)` throws `TRUNCATED` with `pos + size` for slices and `pos` for getters (match the tests).
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** — `feat: EcwError, byte helpers and MemorySource`

---

### Task 3: BlobSource (async range reader)

**Files:**
- Create: `src/io/BlobSource.js`
- Test: `test/io/BlobSource.test.js`

**Interfaces:**
- Consumes: `EcwError`, `ERROR_CODES` (Task 2).
- Produces: `function BlobSource(blob: Blob)` (with `new`); `size` property; `read(start, end) → Promise<Uint8Array>` copying `blob.slice(start, end).arrayBuffer()`.

- [ ] **Step 1: Write failing tests** (Node ≥ 22 has global `Blob`)

```js
var blob = new Blob([Uint8Array.from([1, 2, 3, 4, 5])]);
test("reads the requested range", async function () {
	var s = new BlobSource(blob);
	assert.equal(s.size, 5);
	assert.deepEqual(Array.from(await s.read(1, 4)), [2, 3, 4]);
});
test("empty range returns empty array", async function () { assert.equal((await new BlobSource(blob).read(2, 2)).length, 0); });
test("end past size rejects TRUNCATED", async function () {
	await assert.rejects(new BlobSource(blob).read(3, 9), { code: "TRUNCATED", offset: 9 });
});
test("negative or reversed range rejects INVALID_ARGUMENT", async function () {
	await assert.rejects(new BlobSource(blob).read(-1, 2), { code: "INVALID_ARGUMENT" });
	await assert.rejects(new BlobSource(blob).read(3, 2), { code: "INVALID_ARGUMENT" });
});
test("non-Blob argument throws INVALID_ARGUMENT", function () {
	assert.throws(function () { new BlobSource({}); }, { code: "INVALID_ARGUMENT" });
});
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL.
- [ ] **Step 3: Implement** `src/io/BlobSource.js`. Detect Blobs with `typeof blob.slice === "function" && typeof blob.size === "number"`.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** — `feat: BlobSource async range reader`

---

### Task 4: Reverse-engineering probes and FINDINGS log

**Files:**
- Create: `_dev/ecw-decode/hexAnnotate.mjs`, `_dev/ecw-decode/byteStats.mjs`, `_dev/ecw-decode/probeLib.mjs`, `_dev/ecw-decode/FINDINGS.md`
- Test: `test/dev/probeLib.test.js`

**Interfaces:**
- Produces (`probeLib.mjs`, pure, tested): `formatHexRows(bytes, baseOffset, annotations) → string[]` where `annotations` is `[{ offset, length, label }]` and each row is `"0x%08x: <16 hex bytes>  <ascii>  ; labels starting in this row"`; `shannonEntropy(bytes) → number` (bits per byte, 0–8); `histogramTop(bytes, n) → [{ value, count }]` sorted by count desc then value asc.
- CLI: `node _dev/ecw-decode/hexAnnotate.mjs <file> <start> <length> [annotations.json]`; `node _dev/ecw-decode/byteStats.mjs <file> <start> <length>`. Both read with `fs.openSync` / `fs.readSync` of only the requested range; numbers accept `0x` hex.

- [ ] **Step 1: Write failing tests** `test/dev/probeLib.test.js`

```js
test("entropy of constant bytes is 0", function () { assert.equal(shannonEntropy(new Uint8Array(64)), 0); });
test("entropy of all 256 values once is 8", function () { assert.equal(shannonEntropy(Uint8Array.from({ length: 256 }, function (_, i) { return i; })), 8); });
test("histogramTop orders by count then value", function () {
	assert.deepEqual(histogramTop(Uint8Array.from([5, 1, 5, 1, 9]), 2), [{ value: 1, count: 2 }, { value: 5, count: 2 }]);
});
test("formatHexRows labels the row an annotation starts in", function () {
	var rows = formatHexRows(Uint8Array.from({ length: 20 }, function (_, i) { return 0x41 + i; }), 0x100, [{ offset: 0x112, length: 2, label: "w" }]);
	assert.equal(rows.length, 2);
	assert.match(rows[0], /^0x00000100: 41 42/);
	assert.match(rows[1], /; w$/);
});
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL.
- [ ] **Step 3: Implement** `probeLib.mjs` and the two CLIs. Seed `FINDINGS.md` with: sample table (private RGB v2 sample, no identifying values), the spec §7 offset table, the level-table rule, GDAL's floor-sized overviews and pair-repeated coarsest overview, a `⭐ CRACKED` banner on header + level table, and an empty "Ruled out (don't re-walk)" list.
- [ ] **Step 4: Copy the private ECW into `samples/`** (gitignored), then run `npm test` and `node _dev/ecw-decode/hexAnnotate.mjs samples/<sample>.ecw 0 0x60` — Expected: tests pass; dump shows `0x00000000: 65 02 01 02 0a 04`.
- [ ] **Step 5: Commit** — `chore: hex/entropy probes and FINDINGS log`

---

### Task 5: EcwHeader

**Files:**
- Create: `src/format/EcwHeader.js`, `test/helpers/buildEcwHeader.js`
- Test: `test/format/EcwHeader.test.js`

**Interfaces:**
- Consumes: `MemorySource`, `readAscii`, `EcwError` (Task 2).
- Produces:
  - `parseHeader(source) → { version, levelCount, width, height, bands, blockWidth, blockHeight, compressionTarget, hasGeoreference, cellSizeX, cellSizeY, originX, originY, datum, projection, units: null, levelTableOffset: 0x59 }`.
  - Constants exported: `HEADER_FIXED_LENGTH = 0x59`, `LEVEL_RECORD_LENGTH = 21`, `ECW_SIGNATURE = 0x65`.
  - Test helper `buildEcwHeader(overrides) → Uint8Array` writing the spec §7 layout. Defaults: version 2, width 1000, height 600, bands 3, block 64×64, compressionTarget 8, georef flag 1, cellSizeX 0.5, cellSizeY −0.5, originX 1000.25, originY 5000.75, datum `"WGS84"`, projection `"LOCAL"`, levelCount 3, and level records from the ceil rule (125×75, 250×150, 500×300, `a = b = c = 1`). Overrides: any field, plus `levels: [{ level, width, height, a, b, c }]` and `truncateAt: n`.
- Field map: `0x00` u8 signature, `0x01` u8 version, `0x04` u8 levelCount, `0x06` u32 BE width, `0x0A` u32 BE height, `0x0E` u16 BE bands, `0x12`/`0x14` u16 BE block W/H, `0x16` u16 BE compressionTarget, `0x18` u8 georef flag (`hasGeoreference = flag === 1`), `0x19`/`0x21`/`0x29`/`0x31` f64 LE cellX/cellY/originX/originY, `0x39` and `0x49` 16-byte ASCII datum/projection.

- [ ] **Step 1: Write failing tests**

```js
test("parses every field of a synthetic header", function () {
	var h = parseHeader(new MemorySource(buildEcwHeader({})));
	assert.deepEqual(h, { version: 2, levelCount: 3, width: 1000, height: 600, bands: 3, blockWidth: 64, blockHeight: 64,
		compressionTarget: 8, hasGeoreference: true, cellSizeX: 0.5, cellSizeY: -0.5, originX: 1000.25, originY: 5000.75,
		datum: "WGS84", projection: "LOCAL", units: null, levelTableOffset: 0x59 });
});
test("widths above 2^31 read unsigned", function () { assert.equal(parseHeader(new MemorySource(buildEcwHeader({ width: 0x90000000 }))).width, 0x90000000); });
test("16-char names with no NUL are read whole", function () {
	var h = parseHeader(new MemorySource(buildEcwHeader({ datum: "ABCDEFGHIJKLMNOP", projection: "QRSTUVWXYZ012345" })));
	assert.equal(h.datum, "ABCDEFGHIJKLMNOP");
	assert.equal(h.projection, "QRSTUVWXYZ012345");
});
test("wrong signature throws NOT_ECW at 0", function () {
	var b = buildEcwHeader({}); b[0] = 0x89; // PNG first byte
	assert.throws(function () { parseHeader(new MemorySource(b)); }, { code: "NOT_ECW", offset: 0 });
});
test("version other than 2 throws UNSUPPORTED_VERSION at 1", function () {
	assert.throws(function () { parseHeader(new MemorySource(buildEcwHeader({ version: 3 }))); }, { code: "UNSUPPORTED_VERSION", offset: 1 });
});
test("buffer shorter than the fixed header throws TRUNCATED at 0x59", function () {
	assert.throws(function () { parseHeader(new MemorySource(buildEcwHeader({ truncateAt: 0x40 }))); }, { code: "TRUNCATED", offset: 0x59 });
});
test("zero width, height or bands throws NOT_ECW", function () {
	assert.throws(function () { parseHeader(new MemorySource(buildEcwHeader({ bands: 0 }))); }, { code: "NOT_ECW", offset: 0x0E });
});
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL.
- [ ] **Step 3: Implement** `buildEcwHeader` then `parseHeader`. Check length ≥ `HEADER_FIXED_LENGTH` first, then signature, then version.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** — `feat: parse ECW header and georeferencing`

---

### Task 6: EcwLevels

**Files:**
- Create: `src/format/EcwLevels.js`
- Test: `test/format/EcwLevels.test.js`

**Interfaces:**
- Consumes: `parseHeader` output, `HEADER_FIXED_LENGTH`, `LEVEL_RECORD_LENGTH` (Task 5); `buildEcwHeader`.
- Produces:
  - `levelTableEnd(header) → number` = `header.levelTableOffset + header.levelCount * 21`.
  - `parseLevels(source, header) → [{ level, width, height, a, b, c }]`, coarsest first, record `i` at `0x59 + 21 * i`: u8 level, then u32 BE width, height, a, b, c.
  - `expectedLevelDimensions(width, height, count) → [{ width, height }]` (ceil rule, coarsest first) — exported for tests and the refs script; **not** enforced by `parseLevels`.
- Validation in `parseLevels` (`BAD_LEVEL_TABLE`, offset = the record's start): `levelCount === 0` (offset `0x04`); level byte ≠ index; width or height 0; width or height not strictly greater than the previous record's; width > header width or height > header height. Short buffer → `TRUNCATED` at `levelTableEnd(header)`.

- [ ] **Step 1: Write failing tests**

```js
test("expectedLevelDimensions follows the ceil rule", function () {
	assert.deepEqual(expectedLevelDimensions(100001, 50001, 10)[0], { width: 98, height: 49 });
	assert.deepEqual(expectedLevelDimensions(100001, 50001, 10)[9], { width: 50001, height: 25001 });
	assert.deepEqual(expectedLevelDimensions(1000, 600, 3), [{ width: 125, height: 75 }, { width: 250, height: 150 }, { width: 500, height: 300 }]);
});
test("parses synthetic level records", function () {
	var b = buildEcwHeader({}); var s = new MemorySource(b); var h = parseHeader(s);
	assert.equal(levelTableEnd(h), 0x59 + 63);
	assert.deepEqual(parseLevels(s, h)[2], { level: 2, width: 500, height: 300, a: 1, b: 1, c: 1 });
});
test("levelCount 0 throws BAD_LEVEL_TABLE at 0x04", function () { /* buildEcwHeader({ levelCount: 0, levels: [] }) */ });
test("out-of-order level byte throws at that record", function () { /* levels[1].level = 5 → offset 0x59 + 21 */ });
test("non-increasing size throws at that record", function () { /* levels[2] = levels[1] dims → offset 0x59 + 42 */ });
test("level larger than full size throws", function () { /* levels[2].width = 1001 → offset 0x59 + 42 */ });
test("truncated table throws TRUNCATED at table end", function () { /* truncateAt: 0x59 + 30 → offset 0x59 + 63 */ });
```

Each commented test asserts `assert.throws(fn, { code, offset })` with the stated values.

- [ ] **Step 2: Run** `npm test` — Expected: FAIL.
- [ ] **Step 3: Implement** `src/format/EcwLevels.js`.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** — `feat: parse ECW resolution-level table`

---

### Task 7: Reference set and sample parity for header and levels

**Files:**
- Create: `_dev/ecw-decode/makeRefs.mjs`, `test/helpers/samples.js`, `test/samples/header.sample.test.js`
- Modify: `README.md` (add "Running sample tests" section), `_dev/ecw-decode/FINDINGS.md`

**Interfaces:**
- Consumes: `parseHeader`, `parseLevels` (Tasks 5–6).
- Produces:
  - `makeRefs.mjs <file.ecw>` writes into `samples/ref/`: `gdalinfo.json` (`gdalinfo -json`); for each level record `k`, `level-<k>.tif` via `gdal_translate -of GTiff -co COMPRESS=NONE -co INTERLEAVE=PIXEL -srcwin 0 0 <cols*s> <rows*s> -outsize <cols> <rows>` where `s = 2^(levelCount-k)`, `cols = floor(W/s)`, `rows = floor(H/s)` (whole level cells only, so pixels align to the level grid); three full-res crops `crop-origin.tif` (`-srcwin 0 0 256 256`), `crop-aligned.tif` (512×512 at the 64-aligned point nearest the image centre), `crop-straddle.tif` (300×300 at that point + 37). GDAL is found via env `QGIS_BIN` (default `C:\Program Files\QGIS 4.2.3\bin`), with `GDAL_DRIVER_PATH` and `GDAL_DATA` set from the sibling `apps/gdal` folder. Writes `samples/ref/manifest.json` listing each output with its `srcwin`/`outsize`.
  - `test/helpers/samples.js`: `findSample() → { ecwPath, refDir } | null` (first `*.ecw` in `samples/`, and `samples/ref/` if it has `gdalinfo.json`).

- [ ] **Step 1: Write failing sample test** `test/samples/header.sample.test.js`

```js
var sample = findSample();
test("header matches gdalinfo", { skip: sample ? false : "no samples/*.ecw with samples/ref/gdalinfo.json" }, function () {
	var info = JSON.parse(readFileSync(join(sample.refDir, "gdalinfo.json"), "utf8"));
	var h = parseHeader(new MemorySource(readRange(sample.ecwPath, 0, 8192)));
	assert.deepEqual([h.width, h.height], info.size);
	assert.equal(h.bands, info.bands.length);
	assert.deepEqual([h.originX, h.cellSizeX, 0, h.originY, 0, h.cellSizeY], info.geoTransform);
	assert.equal(String(h.version), info.metadata[""].VERSION);
	assert.equal(String(h.compressionTarget), info.metadata[""].COMPRESSION_RATE_TARGET);
});
test("finest level record is ceil(full / 2)", { skip: … }, function () { /* last level === expectedLevelDimensions(...).at(-1) and every record matches expectedLevelDimensions */ });
```

`readRange(path, start, length)` lives in `test/helpers/samples.js` (`fs.readSync` into a `Uint8Array`).

- [ ] **Step 2: Run** `npm test` with `samples/` empty — Expected: sample tests reported as skipped, rest pass.
- [ ] **Step 3: Implement** `makeRefs.mjs` and `samples.js`; run `node _dev/ecw-decode/makeRefs.mjs samples/<sample>.ecw`.
- [ ] **Step 4: Run** `npm test` — Expected: sample tests run and pass. If `geoTransform` differs in the last decimal, compare with a 1e-9 tolerance and record why in `FINDINGS.md`.
- [ ] **Step 5: Confirm nothing private is staged:** `git status --short` shows no `samples/` paths.
- [ ] **Step 6: Commit** — `test: reference set script and header/level parity against gdalinfo`

---

### Task 8: Test-only uncompressed TIFF reader

**Files:**
- Create: `test/helpers/readTiff.js`, `test/helpers/writeTiff.js`
- Test: `test/helpers/readTiff.test.js`, `test/samples/refs.sample.test.js`

**Interfaces:**
- Produces: `readTiff(bytes: Uint8Array) → { width, height, samplesPerPixel, data: Uint8Array }` for baseline TIFF: `II` or `MM`, 8-bit samples, `Compression = 1`, `PlanarConfiguration = 1`, strips (`StripOffsets`/`StripByteCounts`, SHORT or LONG); throws `Error("unsupported TIFF: <tag>")` otherwise. `writeTiff({ width, height, samplesPerPixel, data, bigEndian, rowsPerStrip }) → Uint8Array` (fixtures only).

- [ ] **Step 1: Write failing tests**

```js
test("round-trips a 3×2 RGB image, little-endian, one strip", function () { /* writeTiff → readTiff deepEqual */ });
test("reads big-endian with multiple strips", function () { /* rowsPerStrip: 1 */ });
test("rejects compressed TIFF", function () { /* patch Compression to 5 → throws /unsupported TIFF: Compression/ */ });
// test/samples/refs.sample.test.js (skips without refs)
test("every manifest reference decodes to its outsize with 3 samples per pixel", { skip: … }, function () { /* for each manifest entry readTiff dims === outsize */ });
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL.
- [ ] **Step 3: Implement** both helpers.
- [ ] **Step 4: Run** `npm test` — Expected: all pass (sample test runs locally).
- [ ] **Step 5: Commit** — `test: minimal TIFF reader for reference parity`

---

### Task 9: `openEcw` (info only), georef bounds, README API

**Files:**
- Create: `src/format/georef.js`, `src/EcwReader.js`
- Modify: `src/index.js`, `README.md`, `CHANGELOG.md`
- Test: `test/format/georef.test.js`, `test/EcwReader.test.js`

**Interfaces:**
- Consumes: `BlobSource` (Task 3), `MemorySource`, `parseHeader`, `parseLevels`, `levelTableEnd`.
- Produces:
  - `pixelWindowToBounds(info, x, y, width, height) → { minX, minY, maxX, maxY }` using `X = originX + col * cellSizeX`, `Y = originY + row * cellSizeY`, then min/max (so positive or negative `cellSizeY` both work).
  - `openEcw(blob, options) → Promise<EcwReader>`: reads `HEADER_READ_BYTES = 8192` (or `blob.size` if smaller) through `BlobSource`, parses header and levels.
  - `EcwReader#info` = `{ version, width, height, bands, blockWidth, blockHeight, compressionTarget, levels: [{ width, height }, … , { width: W, height: H }], cellSizeX, cellSizeY, originX, originY, datum, projection, units }` — `levels` coarsest first, full resolution last.
  - `EcwReader#readRegion()` and `#readRegionToScratch()` reject `EcwError(NOT_IMPLEMENTED)` until Plan 2; `#close()` is idempotent.
  - `src/index.js` exports: `VERSION`, `openEcw`, `EcwError`, `ERROR_CODES`, `parseHeader`, `parseLevels`, `pixelWindowToBounds`, `MemorySource`, `BlobSource`.

- [ ] **Step 1: Write failing tests**

```js
test("bounds of the full image, north-up", function () {
	var info = { originX: 1000, originY: 5000, cellSizeX: 0.5, cellSizeY: -0.5 };
	assert.deepEqual(pixelWindowToBounds(info, 0, 0, 1000, 600), { minX: 1000, minY: 4700, maxX: 1500, maxY: 5000 });
});
test("bounds with positive cellSizeY", function () { /* originY 0, cellSizeY 0.5, window y 2 h 4 → minY 1, maxY 3 */ });
test("openEcw exposes info from a synthetic header", async function () {
	var r = await openEcw(new Blob([buildEcwHeader({})]));
	assert.equal(r.info.width, 1000);
	assert.deepEqual(r.info.levels.at(-1), { width: 1000, height: 600 });
	assert.equal(r.info.levels.length, 4);
});
test("openEcw on a PNG rejects NOT_ECW", async function () { /* Blob of 89 50 4E 47 + 100 zero bytes */ });
test("openEcw on an 8-byte blob rejects TRUNCATED", async function () { /* buildEcwHeader truncateAt 8 */ });
test("readRegion rejects NOT_IMPLEMENTED; close is idempotent", async function () { /* … */ });
test("public exports", async function () { /* Object.keys(await import("../src/index.js")).sort() deepEqual the list above */ });
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL.
- [ ] **Step 3: Implement**; README: install, `openEcw` + `info` example, error codes table, status ("header and georeferencing only; pixel decode in progress"), clean-room statement. CHANGELOG `Unreleased`: header/level reading.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** — `feat: openEcw with header, georeferencing and levels`

---

### Task 10: `applyTransparency`

**Files:**
- Create: `src/post/applyTransparency.js`
- Test: `test/post/applyTransparency.test.js`

**Interfaces:**
- Produces: `applyTransparency(rgba: Uint8ClampedArray, threshold: number) → rgba` (in place). Pixel alpha → 0 when R, G and B are all ≤ `threshold`; other pixels untouched (including existing alpha). `threshold` must be an integer 0–255, else `EcwError(INVALID_ARGUMENT)`.

- [ ] **Step 1: Write failing tests**

```js
test("all bands at threshold → transparent", function () { /* [3,3,3,255], t=3 → alpha 0 */ });
test("one band above threshold stays opaque", function () { /* [3,4,3,255], t=3 → alpha 255 */ });
test("threshold 0 only clears pure black", function () { /* [0,0,0,255],[1,0,1,255] → [0,255] alphas */ });
test("existing alpha of kept pixels is preserved", function () { /* [9,9,9,128], t=3 → 128 */ });
test("invalid threshold throws", function () { /* -1, 256, 1.5, NaN → INVALID_ARGUMENT */ });
test("returns the same array", function () { /* identity */ });
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** — `feat: transparentBelow post-step`

---

### Task 11: `clipToPolygon`

**Files:**
- Create: `src/post/clipToPolygon.js`
- Test: `test/post/clipToPolygon.test.js`

**Interfaces:**
- Consumes: bounds shape from `pixelWindowToBounds` (Task 9).
- Produces: `clipToPolygon(rgba, width, height, bounds, rings) → rgba` (in place). `rings`: array of rings, each an array of `[x, y]` map coordinates (closed implicitly). Row 0 is `maxY` (north-up output). Pixel `(c, r)` centre: `x = minX + (c + 0.5) * (maxX - minX) / width`, `y = maxY - (r + 0.5) * (maxY - minY) / height`. Outside (even-odd over all rings) → alpha 0. Empty `rings` → no change. Rings with < 3 points, or non-finite coordinates → `INVALID_ARGUMENT`.
- Algorithm (scanline, even-odd): per row, collect `x` crossings of every edge `(x0,y0)-(x1,y1)` with `(y0 <= y) !== (y1 <= y)` at `x0 + (y - y0) * (x1 - x0) / (y1 - y0)`; sort; a pixel is inside when its centre lies in `[xs[2i], xs[2i+1])`.

- [ ] **Step 1: Write failing tests** (bounds `{ minX: 0, minY: 0, maxX: 10, maxY: 10 }`, 10×10 opaque image unless stated; helper `alphaGrid(rgba, w, h)` returns rows of `0/1`)

```js
test("axis-aligned square keeps only centres inside", function () { /* ring [[2,2],[8,2],[8,8],[2,8]] → rows 2..7, cols 2..7 opaque, 36 opaque total */ });
test("edge exactly through pixel centres follows the half-open rule", function () { /* ring x from 2.5 to 7.5 → cols 2..6 opaque (centre 2.5 in, 7.5 out) */ });
test("concave L-shape", function () { /* expected grid literal */ });
test("inner ring makes a hole", function () { /* outer 1..9, inner 4..6 → 4 centres clear in middle */ });
test("ring entirely outside clears everything", function () { /* [[20,20],[30,20],[30,30]] → all alpha 0 */ });
test("self-touching ring (bow-tie) uses even-odd", function () { /* expected grid literal */ });
test("empty rings is a no-op", function () { /* all alpha 255 */ });
test("scaled output maps output pixel centres through bounds", function () { /* width=height=5 over the same bounds, square 2..8 → output cols/rows 1..3 opaque */ });
test("north-up: row 0 is maxY", function () { /* triangle in top half → only rows 0..4 can be opaque */ });
test("invalid ring throws INVALID_ARGUMENT", function () { /* [[0,0],[1,1]] and [[0,0],[NaN,1],[2,2]] */ });
```

Write the "expected grid literal" tests by hand-computing pixel centres before implementing.

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** — `feat: clipPolygon post-step`

---

### Task 12: ScratchBinaryFile (OPFS)

**Files:**
- Create: `src/io/ScratchBinaryFile.js`, `test/helpers/fakeOpfs.js`
- Test: `test/io/ScratchBinaryFile.test.js`

**Interfaces:**
- Consumes: source contract and `EcwError` (Task 2).
- Produces (all accept `options.root`, a `FileSystemDirectoryHandle`-like; default `await navigator.storage.getDirectory()`; files live in sub-directory `SCRATCH_DIR = "ecw-scratch"`):
  - `openScratchSyncWriter(id, options) → Promise<{ write(bytes), writeAt(bytes, pos), truncate(n), bytesWritten(), close() }>` — worker only; methods synchronous.
  - `openScratchReader(id, { byteLength, windowSize = 4 * 1024 * 1024, root }) → Promise<ScratchSource>` — `ScratchSource` implements the full source contract plus `close()`; `length()` = `byteLength` when given (caps page padding), else file size; reads refill a sliding window via `handle.read(buf, { at })`; reads spanning the window edge must return correct bytes.
  - `removeScratchFile(id, options) → Promise<void>` (missing file is not an error).
  - `sweepStaleScratchFiles({ maxAgeMs = 86400000, now = Date.now(), root }) → Promise<number>` (count removed; uses `(await handle.getFile()).lastModified`).
- `test/helpers/fakeOpfs.js`: `createFakeRoot()` returning an in-memory directory with `getDirectoryHandle(name, { create })`, `getFileHandle(name, { create })`, `removeEntry(name)`, async iterator `values()`; file handles with `getFile() → { size, lastModified }`, `createSyncAccessHandle()` → `{ read(buf, { at }), write(buf, { at }), truncate(n), getSize(), flush(), close() }`; and `setLastModified(name, ms)` for the sweep test.
- Main-thread async writer from Kirra is not needed (all scratch writes happen in the worker) — YAGNI.

- [ ] **Step 1: Write failing tests**

```js
test("writer appends and writes at positions", async function () { /* write [1,2,3]; writeAt([9],1); bytesWritten 3; reader slice(0,3) → [1,9,3] */ });
test("reader getters across a window refill", async function () { /* 64 bytes, windowSize 8; getUint32(6, false) spans the edge → expected value */ });
test("slice spanning several windows", async function () { /* windowSize 8, slice(5, 30) equals source bytes */ });
test("byteLength caps length and reads past it throw TRUNCATED", async function () { /* file 100 bytes, byteLength 60; getUint8(60) → TRUNCATED offset 60 */ });
test("getFloat64 little-endian through the reader", async function () { /* … */ });
test("removeScratchFile deletes and tolerates missing files", async function () { /* … */ });
test("sweep removes only files older than maxAgeMs", async function () { /* two files, one aged 25 h → returns 1 */ });
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**, modelled on Kirra's `ScratchBinaryFile.js` (windowed reader, logical `byteLength`). **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** — `feat: OPFS scratch writer, windowed reader and sweep`

---

### Task 13: Research — block offset table (hand-off to Plan 2)

Research, not TDD: the deliverable is evidence and a documented layout, not `src/` code.

**Files:**
- Create: `_dev/ecw-decode/blockTable.mjs`
- Modify: `_dev/ecw-decode/FINDINGS.md`, `docs/superpowers/specs/2026-10-18-ecw-decoder-design.md` (§7)

**Questions to answer, each with evidence in FINDINGS:**
1. What the bytes between `levelTableEnd` (`0x59 + 21 × levelCount`) and the first rising u64 mean (`00 'R' 'M' 09 01 …`).
2. Where the offset table starts and ends, entry width (u64 LE assumed), and entry count.
3. Ordering: by level (coarsest first?), then by block row/column? Relate the count to the level table's `a/b/c` values and to `ceil(levelWidth / 64) × ceil(levelHeight / 64)`.
4. Whether offsets are absolute or relative to the end of the table; whether the final entry (or the file size) closes the last block.
5. Whether all bands share one block, or each band has its own entry.

**Steps:**
- [ ] **Step 1:** `node _dev/ecw-decode/hexAnnotate.mjs samples/<sample>.ecw 0x100 0x200` and annotate the known fields.
- [ ] **Step 2:** Write `blockTable.mjs <file> <start>`: reads u64 LE entries until the sequence stops rising or exceeds file size; prints count, first/last values, deltas histogram, and file size.
- [ ] **Step 3:** Test each hypothesis (q2–q5) with the probe; record outcomes as `⭐ CRACKED` or in "Ruled out (don't re-walk)".
- [ ] **Step 4:** `node _dev/ecw-decode/byteStats.mjs` on the first three blocks of the coarsest level and record entropy and the first 64 bytes of each (feeds Plan 2's codec work).
- [ ] **Step 5:** Update spec §7 with the confirmed layout.
- [ ] **Step 6: Commit** — `docs: block offset table findings`
- [ ] **Step 7:** Write Plan 2 (`aiPlans/YYYYMMDD-HHMM-ECW-Codec-Plan.md`) covering `EcwBlockIndex`, block internals, codec, `BlockCache`, Worker, `readRegion`/`readRegionToScratch` with post-steps, browser demo, and `0.1.0` release prep.

**Done when:** a stranger can locate any block's bytes from FINDINGS alone, and Plan 2 exists.

**Deferred to Plan 2 (spec items not in this plan):** `EcwBlockIndex`, `src/codec/*`, `BlockCache`, `ecwDecodeWorker` and the `./worker` export, `readRegion` / `readRegionToScratch`, `_dev/ecw-decode/compareRaster.mjs` (needs decoded pixels), `examples/browser/`, coverage reporting in CI.
