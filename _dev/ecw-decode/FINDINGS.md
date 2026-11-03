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
- Full census (`modeCensus.mjs`, 2026-11-03): reads every block's stream table and each stream's first byte, rather than a sample. On samples A, B and C, and on every crafted file, every stream is mode 2, 5 or 6, every stream table is consistent, and the block index ends exactly at the file size. Run it on each new file: the sample test frames only 2,000 spaced blocks, so a rare mode can hide from it.

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

## ⭐ CRACKED: mode 3 streams (range-coded bytes)

- **What it is:** an off-the-shelf adaptive range coder, not a custom scheme.
  - Coder: Schindler-style carry-handling range coder (31-bit range, 7 extra bits, mode byte as the header byte).
  - Model: his quasistatic frequency model, configured like his example compressor: 257 symbols (256 bytes + an end symbol), total 4096, uniform start, rebuild batches doubling from 36 to a target of 2000.
  - Payload: one lead symbol (0, decoded but not counted), then the coefficients as little-endian int16 (low, high).
  - Trailer: a 3-byte big-endian payload length.
  - Spec in `docs/ECW_FORMAT_SPEC.md` ("Mode 3"), code in `src/codec/rangeCoded.js`.
- **How it was established.**
  - The SDK decoder oracle (`mode3Oracle.mjs`) measured the first rebuilt table through the SDK's own band edges: byte 0's band ends at 14,671/65,536, and byte 5's band starts at 3,413.5/14,671 inside it (PINK and BLUE).
  - Those two edges were matched against the published quasistatic model: Dario Phong's write-up of Schindler's code, Hugi 18, "Quasi Static model". That is general compression literature, read with Brent's approval; no ECW source.
  - With 257 symbols at total 4096 and the lead not counted, byte 0's band = 9 + 10×50 + 8×51 = 917/4096 (the 14,671 edge), and byte 5's band starts at 917 + 4×9 = 953/4096 (the 3,413.5 edge). The rest of the table is the unseen bytes at 9/4096 each, the "escape ramp" of slope 32 that the sweep showed.
  - Schindler's 31-bit decoder with this model decodes all 31 ground-truth streams, and the result matches everywhere except about a dozen isolated ±2 edge-row values and two all-zero truth planes (both solver limits). All 137 real streams decode to exactly their coefficient count. None uses the end symbol, every lead is 0, every trailer equals the payload length, and the decoder's read-ahead stops 1–2 bytes before the end.
  - The library decoder matches the scratch decoder on all 137 streams (9 ms in total).
  - GDAL pixel parity on sample D (PINK, library reads with skip off against gdal_translate): bit-exact, 0 differing pixels, at levels 1–7. That covers the whole image at levels 1–4 (block 83's level 2), the bottom-right corner, and the bottom edge at levels 5–7 (the mode-3 blocks are at level 6).
  - Open on sample D, not mode 3 (the image centre shows the same, and 0.4.0 has it too):
    - levels 8–10 are ±5 off everywhere (about 90% of pixels, all three channels together, so likely luma; check this sample's quantisation steps for the finest records);
    - a reduced read whose y isn't a multiple of the scale is one row off GDAL's nearest-neighbour phase;
    - reads with unequal x/y scales don't match;
    - level 0 is off (max 119).
- **Why it took so long (the lesson).**
  - The uniform start gives bytes 0–240 a width of exactly 16/4096, so the opening bytes look like raw values. Bytes 241–256 are 15/4096 wide.
  - A flat 1/256 reader sees those narrower bands as a "sign nibble", a "17-symbol context table" and a "1/16 flag". For example, nibble 15 plus [904,964)/1024 is exactly byte 0xFF's band [4066,4081)/4096.
  - The "32-bit coder" finding was an artefact of that same wrong model.
  - The codec suite had been run on the raw bytes, but not with known adaptive *models* layered on a range coder. Checking the published model first would have found it in a day.
- Everything below is the history of the investigation, kept for the record. Facts below that contradict this summary were artefacts of the flat-reader model.

Source: one private sample (D) whose full census (`modeCensus.mjs`) found 137 mode-3 streams. Streams pulled with `modeStreams.mjs`, along with every other stream of the same blocks.

- Where they occur: only band 0 (luma) detail subbands (LH, HL, HH), only in blocks cut short by the level's bottom edge (64×4, 26×4 and 22×13 extents). In those blocks the other band-0 streams are mode 2 (sometimes 6): dense (about 250 of 256 coefficients non-zero), mean |v| ≈ 18, max ≈ 70–120. Mode 2 spends most of its ≈ 500 bytes on the Huffman tree (≈ 100 leaves, mostly 3-byte word leaves). The mode-3 streams for the same kind of content are ≈ 350–365 bytes (≈ 11 bits per coefficient), with no visible table.
- First payload byte is always `00` (137/137).
- Last three bytes are a u24 BE equal to the payload length (bytes after the mode byte, trailer included): 137/137. E.g. a 360-byte payload ends `00 01 68`.
- The body is statistically flat: 1-bits 0.4996, byte entropy 7.996 bits/byte over 46,717 bytes. This points at arithmetic or range coding rather than a prefix code.
- The first bytes are not flat. Counting u16 LE words from offset 1: 0–6 small words (high byte 00, low byte < 0x40; never a mode-6 sign or run tag), then a word that is either ≥ 0xFE00 (69 streams) or has the form `(15−n)<<12 | (0xE or 0xF)<<8 | 0xF0 | n` (65 streams). Byte-pair examples: `f4 bf`, `fa 5e`, `f9 6e`, `f7 8f`. Three streams fit neither.
- Better alignment: read big-endian u16 pairs from payload offset 0 (the leading `00` belongs to the first pair). 136/137 streams begin with pairs `00 v`, where v is a signed 8-bit coefficient written raw (`00 35` = +53, `00 f4` = −12). The raw run is every positive value plus the first negative one. Repeats (`7, 7`) are not cheaper, so no adaptation happens in this run. The number of positives before the first negative is 0:70, 1:38, 2:10, 3:10, 4:6, 5:1, 6:1, close to the ½, ¼, ⅛… a random sign gives. The one exception has a value of `0x7f` (127) followed by the post-break pattern, so 127 may be an escape.
- After the first negative v, the next 16 bits are close to `min(|v|, 16) / 16` of the full range. For |v| ≤ 16 that reads as a nibble equal to |v| − 1 followed by `1110`/`1111` (−12 → `bf…`, −1 → `0e…`, −16 → `fe…`); beyond 16 it saturates at `fe`/`ff`. The 12 bits after that nibble fall in a narrow band, about 0.88–0.94 of the range, whatever v was. Read as interval positions, this looks like an arithmetic coder whose model changes at the first negative coefficient: a flat 2^16 table first, then a structured model.
- Ruled out: an LZMA-style adaptive binary range coder (`00` first byte, 11-bit probabilities, shift 4 or 5) with 16-bit LE/BE values through 8-bit bit-trees, a 16-bit bit-tree, or 8-bit zigzag/signed bit-trees. The decoded magnitudes are wrong (mean |v| ≈ 62 for the 8-bit variants, thousands for the 16-bit ones), and the decoder ends 90+ bytes from the trailer.
- Not a known general-purpose codec (2026-11-03, `codecSuite.mjs`). All 137 streams were run through validated decoders (`codecs.mjs`, tested in `test/dev/codecs.test.js` against hand-built vectors, raw LZMA from Python's `lzma`, and reference-encoder round trips), over five byte windows: payload, with the mode byte, without the leading byte, without the trailer, and both. A match had to decode cleanly, use the whole window, and give `pw × ph` values of 1, 2 or 4 bytes, all on the same stream. Covered:
  - deflate raw / zlib / gzip, Brotli, zstd
  - LZ4 block, LZF, FastLZ 1/2, Snappy, LZSS (Okumura, both flag polarities, two ring fills), LZW (LSB/MSB, 12/16-bit, with/without clear codes, early change), LZO1X
  - raw LZMA with lc 0–4, lp 0–2, pb 0–2
  - the Witten–Neal–Cleary adaptive arithmetic coder (both bit orders, increments 1 and 32, EOF symbol)
  - a Subbotin carry-less range coder with an adaptive byte model
  - Rice k 0–8 (both unary polarities), Exp-Golomb k 0–5 and Elias gamma, both bit orders, zigzag or sign-magnitude

  None matched more than 1 of 137 streams. Positive controls (the neighbours' real coefficients compressed with deflate, Brotli or zstd) are each picked out uniquely, on every stream. Also not a JPEG QM or JPEG 2000 MQ coder: after 186 `0xFF` bytes, the next byte is `0x00` once (QM always stuffs one) and ≥ `0x90` 86 times (MQ never allows that).
- ⭐ The coder is Schindler's range coder (1998 public range-coder design; second tier of the codec suite). Evidence:
  - Its encoder flush ends with the byte count as three big-endian bytes, which is exactly the mode-3 trailer (137/137).
  - Its `encode_short` (a 16-bit value at flat probability) gives exactly the raw `00 v` prefix.
  - Decoding the real streams with `schindler()` (`codecs.mjs`: 31-bit low, 7 extra bits, output byte = low >> 23, normalise while range ≤ 2^23), taking payload byte 0 as the first coder byte, returns the raw prefix as 16-bit values: 53, 181 (= `0xB5`, i.e. −75), …
  - Schindler's encoder writes a header byte `c` before the coder bytes. Here that byte is not in the payload. Plausibly it is the block's mode byte itself (3).
  - The decoder round-trips a reference encoder in `test/dev/codecs.test.js`.
- The model on top (open). After the prefix:
  - The prefix is raw 16-bit values of 8-bit two's-complement coefficients, every positive value plus the first negative one.
  - The next symbol is uniform over 16 and always equals `min(|v|, 16) − 1` for that first negative v (137/137, read with `culShift(4)`).
  - The symbol after that lands in one of two narrow bands of the range (about 0.885 and 0.935) whatever v was, so the model from there on is non-uniform and still to be identified.
- Ground truth (2026-11-03, Brent cleared using the SDK as a black box). `groundTruth.mjs`:
  - GDAL renders the next image level over a mode-3 block, aligned to level cells.
  - Luma adds equally to R, G and B, so floor(Y) of every unclamped pixel is known.
  - Every other coefficient is decoded by ecw-js. Pixels that other undecoded streams can reach are excluded, found by perturbing those streams.
  - The unknown plane is solved by impulse responses and least squares, then nudged by ±1.

  31 single-stream blocks were solved: most reproduce GDAL exactly, the rest within 1–4 pixels. Values can still be off by 1 where rounding can't tell them apart. Every plane begins with its stream's raw prefix, which confirms raster coefficient order.
- Mode-3 structure established against that truth (Schindler decoder, payload byte 0 = first coder byte):
  - While the previous coefficient is ≥ 0 (and at the start): the coefficient is a raw 16-bit value (`encode_short`), holding a signed 8-bit value.
  - After a negative coefficient v: a uniform 16-way symbol `min(|v|, 16) − 1` (the context nibble), then a symbol from that context's table.
  - Context 15's starting table is uniform over 17 symbols at total 1024 (Schindler's quasistatic layout: the first `1024 mod 17` symbols get one extra count). Symbol 15 = literal: a uniform 8-bit byte follows with the coefficient (two's complement).
  - Contexts 0–14 start from a table with 18 symbols: 16 nearly equal symbols, the literal (symbol 16) at [3646, 3871)/4096, and a last symbol exactly as wide as the literal.
  - Every one of the 137 streams codes its first post-prefix coefficient as a literal.
- Byte matching (2026-11-03): re-encoding the true coefficients with Schindler's encoder (mode byte as its header byte), plus the established structure and static tables, reproduces the real bytes exactly through the first two table uses in almost every stream. The third use is where it breaks (all 31 streams; one breaks at the second), whether that use is context 15 or 0–14. So there is one shared state that changes after two updates. The truth is not the cause: allowing ±3 per coefficient changes nothing.
- The context 0–14 starting table equals the context 15 table scaled into 15/16 of the range, plus one 1/16 symbol below the literal: 904 × 3.75 + 256 = 3646, 60 × 3.75 = 225. Coding it in two steps (1/16 flag, then the 1024 table) is byte-identical.
- Ruled out as the update rule:
  - Schindler's quasistatic rebuild, separate or shared, with any target.
  - Simple +inc counts, separate or shared, on the literal.
  - An adaptive nibble model.
  - An escape symbol followed by a raw value.
- Single-band fits at the failing use are inconsistent: the literal sometimes shrinks after literals were coded, sometimes grows. So the change involves more than the literal's band.
- Next: use the SDK as a decoder oracle with crafted mode-3 streams to read the band boundaries and symbol meanings at the third use directly.
- SDK decoder oracle (`mode3Oracle.mjs`, `craftEcw` with `streamOverride`): a crafted one-level 128×8 ECW holds a hand-written mode-3 stream as band 0 LH. GDAL decodes it, and `groundTruth.mjs` reads the plane back. Validation: a real mode-3 stream transplanted into the crafted block decodes to its real-file ground truth exactly (256/256).
- Sign is decided after the byte, by lookahead. A raw or literal byte b ≥ 128 is negative only when the next 4-bit value equals `min(256 − b, 16) − 1`. Then that nibble is consumed, and it is also the context for the next table. Otherwise the 4 bits are left in place and b is a positive value (`00 b5` + raw data → +181; `00 b5` + nibble 15 + literal → −75). This matches peeking with Schindler's `decode_culshift` and updating only on a match. Some combinations (`fb` followed by raw data) make the SDK zero the block.
- Hand-written streams decode exactly for the first 18 coefficients and break from index 18–19 on, whatever the values, coding path or stream length. At index 18 the SDK already reads past the 16-bit unit: the value survives only if the next 16 bits start with `00` (the mode-6 "+value" tag). So the decoder changes how it reads the stream at a fixed point near coefficient 18. Real streams follow that change; my crafted ones don't yet.
- Oracle on table updates. My encoder and decoder agree on every crafted stream, so SDK differences are real.
  - Context 15: any number of consecutive uses decode exactly.
  - Contexts 0–14: the first use decodes exactly. After any context 0–14 use, the next table use (any context) still decodes its literal byte, but the following raw unit reads exactly one low (X → X − 1 for X = 2..64). Larger X also moves the byte.
  - Not explained by any of these: literal count increments, scaled totals (×2…×255), two-step flag coding, byte+nibble as one 12-bit unit, or `<` versus `<=` renormalisation. The offset is the size of coder rounding, not a table count.
- ⭐ The arithmetic is a 32-bit range coder, not Schindler's 31-bit one. Code value = the first 4 payload bytes, range starts at 2^32, renormalise while range < 2^24, and the last symbol of a table takes the leftover range.
  - Raw 16-bit units come out byte-identical under both coders, which is why the raw prefix never told them apart.
  - The real streams decode identically with 32-, 40- and 48-bit decoders, and worse with the 31-bit one (247 vs 229 matching coefficients over the 31 solved streams).
  - In the oracle, every "X − 1 after N table uses" failure was rounding in my 31-bit encoder. Each context-15 use multiplies the range by 15 (the 60-wide literal) and each context 0–14 use by 15² (225), so at 15⁴ the 31-bit coder rounds where the 32-bit one doesn't.
  - With a 32-bit encoder (`ENC32=1` in `mode3Oracle.mjs`) those sequences decode exactly.
  - The 3-byte length trailer and leading byte remain as described. (The trailer matches Schindler's done_encoding output, but the arithmetic does not.)
- Genuine model changes that remain, with exact arithmetic:
  - A run of context-15 literals decodes exactly for uses 1–5 and breaks at use 6. Schindler's quasistatic rebuild of a 17-symbol table with literal-only updates does not predict this table (targets 3–2000 tried).
  - All-raw streams break at coefficient 19 (PINK).
  - On real streams the remaining failures are raw reads one byte low and missed sign peeks, at coefficients 5–13.
- Readout caution (PINK): the pixel solver splits values across neighbours when coefficients beyond about ±130 clamp the pixels. Only trust specific surviving values next to such junk.
- Oracle sweeps, 32-bit encoder (PINK, 2026-11-03). Method: width-1 coded positions x/total in place of one table symbol, with plain bytes after, reading off which value the SDK decodes.
  - A positive coefficient's high byte is a flat 8-bit byte (H = floor(x/16) at /4096 in the early state, so positive coefficients can be 16-bit). The H = 0 band is exactly [0, 1/256).
  - A context table symbol decides the previous coefficient's high byte. Symbol 15 = 0xFF (it stays negative, the literal case), 16 = 0x00 (positive), 14 = 0xFE. The ±1 on the next byte in the "L + 1" readings is just the leftover position. So the 17 symbols cover H = 0xF1..0x00.
  - Context 15 (repeated −20): the literal band is static [904, 964) through the 5th use. At the 6th use it is [900, 960) and symbol 16 is [960, 1024). The widths are unchanged (60), and the 4-count remainder has moved from symbols 0–3 to symbol 16, as if the table were rebuilt from equal counts with the remainder at the end. Literal uses are not being counted into it. This rules out a quasistatic rebuild at the 4th update.
  - Context 2 (repeated −3, at /4096): the literal is [3646, 3871) at the 2nd and 3rd uses. At the 4th use no x in 3400–4050 gives −3, even with the class nibble replaced by positions 256–1024. So the class band or the table (or both) has moved.
  - Offline: adaptive quasistatic tables (shared, per-context or split; flag static or adaptive; targets 2–1024) leave the 31 real streams at 239 matched coefficients, the same as static tables. The real streams break in the high-byte / sign path before any table rebuild matters.
- ⭐ One shared counter drives the change (real streams, 2026-11-03).
  - Method: decode the 31 streams, and after every negative measure where the next byte's read lands against its ground-truth value (106 uses).
  - Weights: a context 0–14 use counts 2 (flag + table) and a context 15 use counts 1. Raw coefficients don't count (PINK, unrelated positives prefixed to a chain).
  - Uses with a prior count ≤ 3 are all clean.
  - Prior count 4 with a context 0–14 use: all 11 cases read 0.05–0.09 of a byte step low. Coding that table at a larger total with the same proportions ([3616, +240)/4096) brings all 11 within noise. Rounding is visible here: [904,964) at /1024 beats the same band at /65536 (239 vs 228).
  - Prior count ≥ 5: large moves. One context-15 case reads 17.4 byte steps low, which is the 4/1024 move PINK measured at the 6th context-15 use.
  - After that point nearly every stream breaks at its next symbol, flat reads included, so the change isn't limited to the 17-symbol table.
  - This counter fits PINK's chains: context 15 changes at the 6th use (prior count 5), context 2 at the 4th use (prior count 6).
  - Ruled out: a total-17 count table (66 vs 239), and scaling every total by 2–256 after the point (stays at 245).
- After the counter passes 4–5, every read changes, flat ones included, and not by ±1 (PINK, oracle, 32-bit encoder): a +9 then a +7 tail decodes as 0/−97/−179, and a different total at the 6th context-15 use (/1024, /4096, /16384) doesn't recover it. The coder starts on 2^32 exactly: a range start of 0xFFFFFFFF breaks at coefficient 0.
- All-raw blocks, oracle (BLUE, 2026-11-03):
  - Raw values decode flat through index 18. Sweeping the position of index 18's low byte (the 37th byte after the lead) gives value = x/256 exactly, so there is no rebuild before it.
  - The first wrong value is index 19, whatever the prefix values were.
  - Coding every byte except the lead through a 256-symbol quasistatic model (rebuild interval 18, doubled to 36) makes index 18 come out right for every model precision tried (2^10–2^16), while index 19 stays wrong. Coding the lead through the model too breaks index 18.
  - So a byte model that rebuilds after 36 byte updates, not counting the lead byte, fits the timing. The rebuilt contents are still unknown.
  - First rebuilt table, measured (PINK). Method: 19 coefficients of +5 coded raw, then one 16-bit position z with zeros after.
    - H18: byte 0 covers [0, ≈14,670)/65,536 (0.2238), and the next symbol up is byte 0x01, so the byte order is kept.
    - L19: byte 0 covers about 0.232–0.234 of its range, 4% wider than H's. Bytes 1–4 each get less than 0.0005.
    - So unseen bytes get almost nothing after the rebuild, and that rules out halve-and-OR-1 (129/65,536 each). About 0.55 of the range sits elsewhere: high bytes, or an escape.
  - Byte-model guesses, oracle on whole all-raw blocks (BLUE). Every byte except the lead goes through the guess, written as f: steps. Score = first wrong index; flat coding gives 19.
    - Guesses: a live count model (+1 per byte, updated after every byte), flat until the 37th update, then counts plus an escape of weight E (0–60, fixed or +1 per escape, at the top or the bottom) with an escape + flat byte for unseen bytes. Also a scaled variant (floor 1, +32, E 1254), and the lead byte inside the model.
    - None gets past index 19. Starting the counts one byte earlier, or putting the lead inside the model, breaks index 18. A block cycling only already-seen values (5, 9, 3) fails at 19 too, so the escape isn't the only problem.
    - The SDK reads index 19 as 0 in most of these runs, whatever byte was coded. With PINK's measurements that suggests the bottom ≈ 23% of the rebuilt table is a special symbol (zero or escape-like), not byte 0's learned count: its share is about the same in the high-byte table, where 0 was seen 19 times, and in the low-byte table, where it was never seen.
  - Rebuilt table mapped through the SDK's own tables (BLUE, oracle). Method: 19 units of r:5, then ONE 16-bit position z (so the SDK applies its own band edges), then bottom-of-range positions so the tail decodes as zeros.
    - H18 = 0 for z ≤ 14,670 and not at 14,672, so the zero band ends at 14,671 = 1 + 18 × 815 out of 65,536. That's the quasistatic form (halved floor of 1, plus 18 updates of increment 815, for the 18 zero high bytes H0–H17).
    - L19 inside that band: 0 for z ≤ 3,413, 5 from 3,414, so the 0|5 edge is at 3,413.5/14,671 = 0.2327.
    - The upper part of L19's table is an escape plus a flat byte: value = (z − 6,528)/32, linear up to the top of the band (step-128 sweep). So L19's table is ≈ 0: 0.233, 5: 0.212, escape: 0.555.
    - Bytes 1–4 sit between 0 and 5 in L19's table at under one z unit each. In H18's table byte 1 is at least 2 units wide, so the two tables may differ.
  - Whole-block guesses (all +5): live counts plus a fixed escape of 48 and the lead counted as a 0, with snapshots rebuilt at byte positions 38, 39, 41, 45, 53… (lead = 0; gaps 1, 2, 4, 8), decode through index 20. Every-byte updates, other schedules, or changing the escape at a rebuild stop at 19 or 20. Nothing gets past 20. Small table errors only show up a few symbols later, so the first wrong index doesn't locate the error.
  - An equally good reading of the timing: separate low-byte and high-byte models, each rebuilding after 18 updates, with the leading 00 counted as the high byte of a virtual coefficient −1. The high-byte model's 19th decode is then H18 and the low-byte model's is L19, which matches both measured first-changed bytes. Not yet tested.
- Open: how the tables update. They don't follow the quasistatic model's batched rebuilds, and they don't follow simple +inc counts. A table can change after one use, and contexts 0–14 appear to share state. Also open: the meaning of the non-literal symbols.
- Why a wide overview read fails on a block outside its window: tile-cache padding, not a bug. With the cache off, or with 8 px tiles, the same read succeeds. With the default 32 px tiles (or 64 px), each level's window is rounded out to whole tiles. That rounding at two levels, plus the synthesis filter's reach, crosses into the next block row and column of a coarse record. Output pixels are the same either way.
- Working hypothesis (not confirmed): an adaptive arithmetic/range coder whose models start flat, so the first symbols come out close to raw and the output then becomes dense. The leading `00` and the length trailer would be framing around it.

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

## ⭐ CRACKED: colour space and band-sized level records

- No greyscale file was available, so 1-band files were crafted and decoded by the SDK (`greyCraft.mjs`, `headerSweep.mjs`). With 21-byte level records the SDK refused them at open ("ECW error") for every value of every unknown header byte.
- Level records are 9 + 4 × bands bytes: index, width, height, one step per band. With 13-byte records a 1-band file opens.
- Byte `0x03` is the colour space, named by gdalinfo's COLORSPACE: 0 NONE, 1 GREYSCALE, 2 reported as RGB (the luma/chroma space every real file uses; a 1-band file with it crashes the SDK), 3 MULTIBAND, 4 RGB, 5 YCbCr, 6 unrecognized.
- Only colour space 2 is colour-converted. Constant-LL files with values (100, 20, −10) decode to (87, 100, 136) in space 2 and to (100, 20, 0) in every other space: bands pass through, floored and clamped.
- Record 0's steps scale its LL too (LL 40/30/20 with steps 1/2/3 decodes to 40/60/60); real files all have 1 there.
- `0x10` (u16) must be non-zero; `0x05` must be 4 for a 3-band file to decode; neither changes what gdalinfo reports.
- Result: crafted greyscale (three files, up to 4 levels, odd sizes, empty streams, steps), rgb, yuv with record-0 steps and 4-band multiband files all decode bit-exact against the SDK (about 200,000 pixels, no differences).
- GDAL's ECW driver documentation (public) confirms version 2 is 8 bits per channel and gives COMPRESSION_RATE_TARGET = 100 / (100 − TARGET).

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

## ⭐ CRACKED: complete synthesis rules (bit-exact on crafted files and on Sample A)

1. Columns first (LL with LH, HL with HH), then rows.
2. Odd-odd output pixels interpolate vertical averages floored to quarters; every other pixel uses exact arithmetic. (Flooring the vertical pass for even columns too was the source of the earlier "even rows round up" residual.)
3. Per band, the block holding the output pixel decides which detail subbands take part. A subband whose stream is empty (mode 5) in that block contributes nothing to the pixel, not even the coefficients that neighbouring blocks hold across the edge. With all three empty the band takes the exact path: pure LL interpolation with no quarter flooring.
4. Every level that feeds another synthesis is stored floored to eighths; the requested level keeps full precision. (LL-only 5-level files diverged from level 4 until this was added.)
- How rule 3 was found: `cornerBisect.mjs` re-crafts Sample A's first four records as a small file, which the SDK decodes identically to the real overview. That file kept our last 12 level-4 mismatches. Zeroing coefficients narrowed them to two: an HH in one block and an HL just across the block row below, both chroma. A synthetic file with constant LL and just those two coefficients reproduced it: the SDK's pixels on each side of the edge used only the subband present in their own block.
- Steps on the way: "all three empty → exact" (168 left), then "the exact path ignores neighbours' details too" (77 left), then the per-subband rule (0 left).
- Sample A: 0 differing pixels of 11,157,750 across levels 1–5 and the full-resolution crops. The sample test now demands exact equality.
- Sample B (a second private file from a different encoding run: higher compression target, dequantisation steps that are not powers of two): 0 differing pixels of 15,631,387 on its first run, with no decoder changes.
- Sample C (a small file from another source: geographic coordinates, compression target 25, two level records, steps up to 25/75/75): 0 differing pixels on its first run, including the whole image at full resolution.
- Ruled out on the way: next / both / either block rules; per-block (all bands) emptiness; eighth storage on one path only; truncating instead of flooring the eighths (31,890 mismatches).

## History (resolved): what was left at deeper levels

- Crafted files (even sizes, mode 6): 1 and 2 levels decode exactly, with random details on every record. With 3 levels, only the last record's details cause mismatches: always at odd-odd pixels, the SDK always 1 lower, and only where our luma is within ~5/64 above an integer.
- The SDK's intermediate levels floor-match ours exactly (GDAL outsize at levels 1 and 2 = 100%).
- Almost every mismatch has a nonzero HH coefficient within ±2 of the pixel (our model uses only the HH at the pixel). So at the finest synthesis step the SDK's HH reach is wider than ours with small weights.
- Also: odd image sizes (crafted 491×257, two levels) give 98.6% exact, so edge handling for odd sizes differs slightly.
- Crafted mode-2 streams from the test encoder (long chain codes) are not decoded the same by the SDK; real mode-2 streams are. Likely a code-length limit in the SDK; not investigated.
- Ruled out here: fixed-point lifting with 2–8 fractional bits (floor / trunc / round); limited precision between row and column passes; phase-specific truncation of intermediate levels.

## History (resolved): the last ±1

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
