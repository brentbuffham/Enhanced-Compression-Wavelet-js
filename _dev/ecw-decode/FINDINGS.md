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

## Partly cracked: mode 2 streams

- Payload: u32 LE `N`, then an `N`-byte table, then a high-entropy bitstream (mostly 1-bits on sparse blocks: a dominant short code).
- Table tokens are byte-aligned. Three kinds seen across 400 tables:
  - `0x00` (most common)
  - `0x80` followed by a u16 LE mode-6 word (all three tags seen: + value, − value, zero run). Example `80 21 80` = 0x8021 = 33 zeros in the 59×1 block, matching its mode-6 neighbours.
  - single bytes `0x41–0x4F`, `0x51–0x5F`, `0x61–0x6F` (low nibble 0 never appears): three kinds × values 1–15, likely compact forms of the three mode-6 tags.
- With that tokenisation 264 of 400 tables end exactly at `N`; the rest overrun by one byte (all large level-0 tables so far). Something in the tokenisation or the meaning of `N` is still off.
- Ruled out: bit-packed pre-order tree (any bit order, leaf flag, 8/16-bit symbols); byte pre-order tree with `00` as internal node (closes after a few tokens).

## Open (for the codec plan)

- What modes `2` and `6` are (likely candidates: run-length plus Huffman, or an adaptive arithmetic coder). Bytes after the tag start e.g. `27 01 00 …` and `20 80 01 …`.
- Meaning of level-record `a/b/c`, header bytes `0x02–0x03`, `0x05`, `0x10`, and the index flag byte.
- Quantisation (header compression target is 8), wavelet filter, and colour transform.

## Black / transparency

- ECW v2 has no alpha band. Off-footprint areas are lossy near-black (values 0–2, smeared at edges), not exact zeros.

## Ruled out (don't re-walk)

- Offsets in the block index are not absolute file offsets (they start at 0).
- The index is not one entry per band per block (count matches blocks exactly).
- The `RM` bytes after the level table are not a marker; they belong to the index length.
