# ECW decode findings

Running log of what the bytes say. Facts move into `src/` only through a failing test.
Sample details (names, coordinates, sizes) stay in the gitignored `samples/PRIVATE-NOTES.md`.

## Samples

| Name | Kind | Version | Bands | Notes |
|---|---|---|---|---|
| A | Private RGB orthophoto | 2 | 3 | Large (hundreds of MB), local mine grid. Reference set from QGIS GDAL (ECW SDK 5.5). |

## ⭐ CRACKED: fixed header

Integers big-endian, doubles little-endian.

| Offset | Type | Meaning | Status |
|---|---|---|---|
| `0x00` | u8 `0x65` | Signature byte | hypothesis (one sample) |
| `0x01` | u8 | Format version, `2` (gdalinfo `VERSION=2`) | likely |
| `0x02`–`0x03` | `01 02` | Unknown | open |
| `0x04` | u8 | Level-record count | ✅ |
| `0x05` | u8 `4` | Unknown | open |
| `0x06` | u32 BE | Width | ✅ vs gdalinfo |
| `0x0A` | u32 BE | Height | ✅ vs gdalinfo |
| `0x0E` | u16 BE | Bands | ✅ vs gdalinfo |
| `0x10` | u16 BE `1` | Unknown | open |
| `0x12` / `0x14` | u16 BE | Block width / height (64 / 64) | likely |
| `0x16` | u16 BE | Compression target (gdalinfo `COMPRESSION_RATE_TARGET`) | likely |
| `0x18` | u8 `1` | Georeferencing-present flag | hypothesis |
| `0x19` / `0x21` | f64 LE | Cell size X / Y (Y negative, north-up) | ✅ vs gdalinfo |
| `0x29` / `0x31` | f64 LE | Origin X / Y (top-left corner) | ✅ vs gdalinfo |
| `0x39` | 16 bytes ASCII, NUL-padded | Datum name | likely |
| `0x49` | 16 bytes ASCII, NUL-padded | Projection name | likely |

- Georeferencing doubles are stored with a lost last bit or two (Sample A's cell size is one ULP off a round value). GDAL reports the tidied value; we return the raw double and the parity test allows 1e-9.

## ⭐ CRACKED: level table

- Starts at `0x59`, `levelCount` records of 21 bytes: u8 level index, u32 BE width, u32 BE height, three u32 BE `a`, `b`, `c`.
- Coarsest first. Level `k` of `n` is `ceil(W / 2^(n-k))` × `ceil(H / 2^(n-k))`. Full resolution is not a record.
- Sample A: `a/b/c` stay at 1 for the coarsest levels, then grow with level. Meaning open.
- GDAL reports floor-sized overviews and omits the coarsest stored level. Its coarsest overview repeats every value in pairs: GDAL upsamples the next level down.

## ⭐ CRACKED: block index

Right after the level table (`E = 0x59 + 21 × levelCount`):

| Offset | Type | Meaning | Evidence |
|---|---|---|---|
| `E` | u32 BE `L` | Byte length of the index body that follows, counted from `E + 4` | `E + 4 + L` is exactly where the first block's bytes start |
| `E + 4` | u8 `1` | Index flag/format byte (meaning open) | always 1 on Sample A |
| `E + 5` | `(L - 1) / 8` × u64 LE | Block offsets, **relative to `dataStart = E + 4 + L`**, plus one end marker | first offset is 0; last offset + `dataStart` equals the file size exactly |

- Entry count = Σ over level records of `ceil(levelWidth / blockWidth) × ceil(levelHeight / blockHeight)`, plus 1. Sample A matches exactly.
- Order: level-major, coarsest level first; within a level, row-major (on Sample A the narrow edge blocks of level 0 sit exactly where row-major order puts them).
- Block `i` occupies `[dataStart + off[i], dataStart + off[i+1])`.
- One entry per block, not per band: all bands share a block.
- On Sample A, bytes that look like an `'R' 'M'` marker in a hex dump are just the middle of the length `L`.

## ⭐ CRACKED: block framing

- A block starts with `streams - 1` u32 BE offsets, then the streams. Offsets are relative to the end of that header; stream 0 starts at offset 0.
- Level 0 (coarsest) blocks have **12 streams**; every other level has **9**. Reading: 3 bands × 4 subbands (LL, LH, HL, HH) at level 0, and 3 bands × 3 detail subbands above it.
- Order looks band-major: stream sizes come in groups (level 0: 4 per band; others: 3 per band) and band 0's streams are clearly the largest.
- First byte of every stream is a mode tag. Only three values seen across 4,000 sampled blocks:
  - `5`: empty stream, always exactly 1 byte long (all-zero subband). 31,399 of 36,003 streams.
  - `2`: coded stream (3,271).
  - `6`: coded stream, a second method (1,333).
- Streams 3 to 8 (bands 1 and 2) are empty in about 98% of blocks, while streams 0 to 2 are coded about 40% of the time. Hypothesis: an internal luma/chroma colour transform, with chroma detail mostly quantised to zero.
- Whole-block entropy is about 7.5 bits/byte: real entropy coding, not raw coefficients.

## ⭐ CRACKED: mode 6 streams (run-length words)

- Payload after the mode byte is u16 LE words. Top two bits are a tag, low 14 bits a magnitude:
  - `00`: value `+m`
  - `01`: value `-m`
  - `10`: `m` zeros
  - `11`: never seen
- Self-delimiting: the decoded value count equals the block's extent in its level (`min(64, levelW - col*64) × min(64, levelH - row*64)`), and the stream ends exactly on its last word. Checked on all 2,055 mode-6 streams in 6,000 sampled blocks: 2,055 exact, 0 mismatches.
- Example (59×1 edge block, band 0 first stream): `8020 0001 4005` then 25 literals → 32 zeros, +1, −5, then image-like values 31…121.

## ⭐ CRACKED: mode 2 streams (Huffman-coded run-length symbols)

- Payload after the mode byte:
  1. u16 LE `N`: number of nodes in the Huffman tree.
  2. `N` tree tokens in pre-order (node, left subtree, right subtree):
     - `0x00`: internal node
     - `0x80` + u16 LE word: leaf holding a mode-6 word (`00` +m, `01` −m, `10` m zeros)
     - `0x4v`: leaf `+v` (v = 1–15)
     - `0x5v`: leaf `−v`
     - `0x6v`: leaf `v` zeros
     (the same tag order as mode 6, squeezed into one byte for magnitudes up to 15)
  3. The coded bits, read **LSB-first** within each byte; bit `0` = left branch, `1` = right.
- Decode symbols until the block extent's value count is reached. It always lands exactly on a symbol boundary.
- The encoder writes one extra byte after the last code: 8–15 bits are always left over.
- Checked on 6,000 mode-2 streams from 20,000 sampled blocks (all levels, all subbands): tree closes at exactly `N` nodes in 1,500/1,500, and 6,000/6,000 decode to exactly the extent with 8–15 bits left.
- Example (9 nodes): tree `. +1 . z62 . . z3585 z319 −1`, data `2b ef 32 00` → `z319 +1 z62 +1 0 z62 0 +1 z62 +1 z3585`: a short vertical line of coefficients at columns 62–63, rows 4–7.
- Ruled out on the way: u32 table length (the first two `00` after `N` are tree nodes); bit-packed trees; reading short tokens as all-values or `5v` as runs.

## ⭐ CRACKED: coefficient layout

- Each stream lists its block's values row by row over the block's extent in its level.
- Level record `k`'s subbands are the size of record `k`; synthesising them gives an image twice the size, which is the LL of record `k + 1` (cropped to that record's size). Record 0 carries the LL. Ten records plus synthesis give the full image.

## ⭐ CRACKED (to ±1–3 grey levels): inverse wavelet and colour

- 1-D synthesis, applied to rows (with `HL` as the row high-pass) and then to columns (`LH` / `HH`):
  - even sample `x[2n] = s[n] − (d[n−1] + d[n]) / 2`
  - odd sample `x[2n+1] = (s[n] + s[n+1]) / 2 + d[n]`
  - edges clamp to the nearest coefficient.
  Fitted from the GDAL level-1 reference: per phase, the taps come out as exactly this pattern (×0.95–0.97 gain from the fit), no taps beyond ±1, and a 5×5 fit does not improve on it.
- Coefficients are used as decoded: no dequantisation scale (detail scale 1.0 beats 0.8–1.05), no mid-bin offset.
- Band 0 is luma, bands 1 and 2 chroma (Cb-like, Cr-like). A free 3×4 fit on 52,000 level-2 pixels gives `R = Y + 1.4017·Cr`, `G = Y − 0.3537·Cb − 0.7082·Cr`, `B = Y + 1.7705·Cb`: BT.601 YCbCr, luma gain 1.000.
- GDAL's level-k output is our reconstruction at level k. Its coarsest overview (record 0's size) is the record-1 reconstruction sampled at even pixels.
- Accuracy with float synthesis and BT.601 + rounding (+0.5 on R and B, quantisation steps applied): levels 1–5 are 78–70% exact, max error 2–3; full resolution 24% exact, max error 4, mean 1.1. Level 5 rebuilds in 1.8 s in Node; `readRegion` runs the whole reference set in about 3 s.

## ⭐ CRACKED: quantisation steps (level-record a / b / c)

- The three u32 values in each level record are per-band dequantisation steps for that record's detail subbands: `a` for band 0 (luma), `b` for band 1, `c` for band 2. LL is used as decoded (record 0 has a = b = c = 1 on Sample A, so an LL step cannot be confirmed yet).
- Evidence: Sample A's steps are 1 for the coarse records, then a = 2, 4, 8 and b = c = 3, 6, 12, 24 at the finest records. Applying them at full resolution cuts the worst error against GDAL from 19 to 4 and the mean from 7.8 to 1.1 (512×512 crop inside the imagery). Applying `a` to all bands leaves chroma errors up to 19.

## Note on the reference set

- The original centre crops fell in the black notch of the footprint and matched trivially. `makeRefs.mjs` now places the aligned and straddle crops inside the imagery (nearest solid point to the imagery centroid on the finest level reference).

## ⭐ CRACKED: colour conversion (exact)

- Method: craft ECW files with chosen coefficients (`_dev/ecw-decode/craft.mjs`, header template from the private sample) and let the SDK decode them through QGIS GDAL. One level with zero details makes every even-even output pixel equal one LL value, so a single file reads out thousands of (Y, Cb, Cr) → RGB pairs.
- The SDK floors Y, Cb and Cr to integers, then: `R = Y + T_R(Cr)`, `G = Y + T_GB(Cb) + T_GR(Cr)`, `B = Y + T_B(Cb)`, clamped. Each table is `floor(k·c + off + 0.5)` with k / off = 1.40228 / 1.011 (R), 1.77151 / 1.0075 (B), −0.34349 / −0.0075 (G from Cb), −0.71464 / −0.03 (G from Cr). These reproduce all 256 entries of each table swept from the SDK, and 100% of 65,000 random combinations and of half / quarter fractional inputs.
- Effect on Sample A: level 1 now matches GDAL exactly (100%); levels 2–5 are 99.3 → 93.5% exact; full resolution 59% (max error 3).

## ⭐ CRACKED (mostly): synthesis rounding

- Crafted file with a single nonzero coefficient in one record-2 block: mismatches appear across that block's whole 128×128 output area and nowhere else. The SDK has two paths per block.
- General path (the band has at least one nonzero detail stream in the block): the vertical (column) pass runs first and its odd-row averages `(s[k] + s[k+1]) / 2` are floored to quarters; the horizontal pass is exact. Fitted per pixel inside that block: 3,672 / 3,672 odd-odd pixels exact.
- Exact path (the band's LH, HL and HH streams in the block are all empty): no flooring. Decided per band: luma floored + chroma exact scores 99.64% on a crafted file where only luma has details, against 98.53% when every band is floored.
- Crafted results with both rules: 2 levels 100%, odd size 491×257 100%, 3 levels ~99.3%, 4 levels ~97.3%. Something small still escapes at 3+ levels (all remaining crafted mismatches at even-row, odd-column pixels, SDK higher).
- Effect on Sample A: levels 1–2 exact; level 3 99.6%, level 4 98.7%, level 5 97.6%; full resolution 84% exact, max error 3.
- Ruled out while finding this: per-level fixed point (any bit count), mid-pass rounding in rows-first order, floored or rounded horizontal averages, rounding only when storing intermediate levels, per-level pass order.

## Narrowed: what is left at deeper levels

- Crafted files (even sizes, mode 6): 1 and 2 levels decode exactly, with random details on every record. With 3 levels, only the last record's details cause mismatches: always at odd-odd pixels, the SDK always 1 lower, and only where our luma is within ~5/64 above an integer.
- The SDK's intermediate levels floor-match ours exactly (GDAL outsize at levels 1 and 2 = 100%).
- Almost every mismatch has a nonzero HH coefficient within ±2 of the pixel (our model uses only the HH at the pixel). So at the finest synthesis step the SDK's HH reach is wider than ours with small weights.
- Also: odd image sizes (crafted 491×257, two levels) give 98.6% exact, so edge handling for odd sizes differs slightly.
- Crafted mode-2 streams from the test encoder (long chain codes) are not decoded the same by the SDK; real mode-2 streams are. Likely a code-length limit in the SDK; not investigated.
- Ruled out here: fixed-point lifting with 2–8 fractional bits (floor / trunc / round); limited precision between row and column passes; phase-specific truncation of intermediate levels.

## Open: the last ±1

- Black background (all coefficients 0) decodes to (0,0,0); GDAL gives (1,0,1). So the SDK's colour step has offsets or chroma bias we do not reproduce.
- Best so far: float synthesis, BT.601, +0.5 on R and B: 75% exact at level 2. Per-channel searches (rounding mode × offset × coefficient variants) top out at 72–82% per channel; Y/U/V offsets at 73%.
- Ruled out: integer lifting with floor/ceil/trunc at either step (worse); rounding between row and column passes; rounding Y/U/V before conversion; 2×2 averaging of the next level; detail or LL dequantisation offsets; detail scale factors.
- Second round (with quantisation steps known), also ruled out:
  - mid-bin dequantisation `(q ± δ)·step` for δ = 0.25, 0.375, 0.5 and `q·step ± (step−1)/2` (all worse than plain `q·step`);
  - rounding, flooring or truncating each rebuilt level before it feeds the next (much worse);
  - tiled synthesis: error is flat across 128-px block positions at full resolution;
  - a hidden dependence on the next record's details (adding them to the fit does not help);
  - neighbour blending / sub-pixel resampling (3×3 fit puts weight 1.000 on the centre pixel);
  - ordered dither (signed error is a flat −0.04 on an 8×8 grid);
  - swapped short-token signs in mode 2 (mean error 0.23 → 7.3).
- What is left: the SDK's per-pixel values differ from our float reconstruction by roughly ±0.4, evenly in flat and busy areas, and no linear function of our Y/U/V (even with free coefficients) gets past ~80% exact per channel. Error grows slowly with depth (levels 1–5: 78% → 70% exact; full resolution 24%, mean 1.1, max 4).

## Open (for the codec plan)

- Meaning of level-record `a/b/c`, header bytes `0x02–0x03`, `0x05`, `0x10`, and the index flag byte.
- Quantisation (header compression target is 8), wavelet filter, and colour transform.

## Black / transparency

- ECW v2 has no alpha band. Off-footprint areas are lossy near-black (values 0–2, smeared at edges), not exact zeros.

## Ruled out (don't re-walk)

- Offsets in the block index are not absolute file offsets (they start at 0).
- The index is not one entry per band per block (count matches blocks exactly).
- The `RM` bytes after the level table are not a marker; they belong to the index length.
