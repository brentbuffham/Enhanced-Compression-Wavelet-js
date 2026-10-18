# ECW version 2: format notes

A plain description of the ERDAS ECW (Enhanced Compression Wavelet) version 2 raster format, as worked out for `ecw-js`.

## How this was worked out

Everything here comes from the bytes of real ECW files and from comparing decoded output with what GDAL produces through the ECW SDK, used purely as a black box. Some rules were found by writing small ECW files with chosen coefficients and watching how the SDK decodes them. No ECW SDK source code (libecw or Hexagon) was read, copied or translated.

**Confidence.** Each rule below reproduces the SDK's output bit for bit on three independent RGB files: two large orthophotos from different encoding runs and a small image from another source, in projected and geographic coordinates, at compression targets from 8 to 25. That's about 28 million pixels across every overview level and full-resolution crops, with no differences. All three are 3-band, 64×64-block, version 2. Greyscale, multiband and non-yuv colour spaces have been checked on constructed files only (written with chosen coefficients and decoded by the SDK; about 200,000 pixels, no differences). Other block sizes and ECW version 3 haven't been seen. Fields still not understood are listed under [Unknowns](#unknowns).

## Conventions

- Integers are big-endian, except inside the block index and the coefficient streams, which are little-endian (noted where they occur).
- Doubles are IEEE 754, little-endian.
- "Level record k" is the k-th entry in the level table, coarsest first. "Image level j" is the picture reconstructed at that resolution (see [Reconstruction](#reconstruction)).

## File layout

```
0x00   fixed header (89 bytes)
0x59   level table (21 bytes per record)
E      block index: length, flag, offsets
D      block data, one block after another
```

## Fixed header

| Offset | Type | Meaning |
|---|---|---|
| `0x00` | u8 | Signature, `0x65` |
| `0x01` | u8 | Format version, `2` |
| `0x02` | u8 | Unknown (`1` seen) |
| `0x03` | u8 | Colour space (see below) |
| `0x04` | u8 | Number of level records `n` |
| `0x05` | u8 | Unknown (`4` seen) |
| `0x06` | u32 | Width in pixels |
| `0x0A` | u32 | Height in pixels |
| `0x0E` | u16 | Number of bands |
| `0x10` | u16 | Unknown (`1` seen; the SDK refuses `0`) |
| `0x12` | u16 | Block width (64 seen) |
| `0x14` | u16 | Block height (64 seen) |
| `0x16` | u16 | Compression target ratio (GDAL's `COMPRESSION_RATE_TARGET`, which GDAL documents as 100 / (100 − target percent)) |
| `0x18` | u8 | Georeferencing present (`1` seen) |
| `0x19` | f64 LE | Cell size X |
| `0x21` | f64 LE | Cell size Y (negative for north-up) |
| `0x29` | f64 LE | Origin X (top-left corner of the top-left pixel) |
| `0x31` | f64 LE | Origin Y |
| `0x39` | 16 bytes | Datum name, ASCII, NUL-padded |
| `0x49` | 16 bytes | Projection name, ASCII, NUL-padded |

The georeferencing doubles can sit one unit in the last place off a round number. GDAL shows the tidied value; `ecw-js` returns the stored one.

Version 2 files hold 8 bits per channel (GDAL's ECW driver documentation says so; version 3 adds 16-bit).

### Colour space

Byte `0x03`, with the names GDAL reports for each value:

| Value | Name | Bands hold |
|---|---|---|
| 0 | NONE | Values shown as stored |
| 1 | GREYSCALE | One grey band |
| 2 | YUV (GDAL reports "RGB") | Luma and two chroma bands, converted to RGB on decode (see [Colour](#colour)) |
| 3 | MULTIBAND | Any number of bands, shown as stored |
| 4 | RGB | Red, green and blue, shown as stored |
| 5 | YCbCr | Shown as stored |

All the real RGB files seen use 2. Only colour space 2 is colour-converted; every other one passes its bands through, floored and clamped to 0 to 255.

## Level table

`n` records of 9 + 4 × bands bytes (21 for RGB) starting at `0x59`, coarsest first:

| Offset | Type | Meaning |
|---|---|---|
| `+0` | u8 | Record index `k` |
| `+1` | u32 | Record width |
| `+5` | u32 | Record height |
| `+9` | u32 × bands | One dequantisation step per band (for RGB: `a`, `b`, `c`) |

- Record `k` of `n` is `ceil(W / 2^(n-k))` by `ceil(H / 2^(n-k))`. The finest record is half the full resolution; full resolution itself is not a record.
- The steps are 1 for the coarse records and grow towards the finest ones (seen: `a` up to 8 or 9, `b` and `c` about three times `a`). They don't have to be powers of two.

## Block index

Right after the level table, at `E = 0x59 + 21·n`:

| Offset | Type | Meaning |
|---|---|---|
| `E` | u32 | Length `L` of the index body that follows |
| `E + 4` | u8 | Unknown flag (`1` seen) |
| `E + 5` | u64 LE × count | Block offsets relative to `D = E + 4 + L`, then one end marker |

- There is one block per tile of every level record: `ceil(recordWidth / blockWidth) × ceil(recordHeight / blockHeight)` per record, summed over all records, plus one end-marker entry.
- Blocks are ordered by level (coarsest first), then row by row within a level.
- Block `i` occupies `[D + offset[i], D + offset[i + 1])`. The first offset is 0 and the end marker lands exactly on the end of the file.
- All bands share a block.

## Block framing

A block starts with `streams − 1` u32 offsets, then the streams themselves. The offsets are relative to the end of that header; stream 0 starts at 0.

- Blocks of record 0 hold 4 streams per band: LL, LH, HL, HH.
- Blocks of every other record hold 3 streams per band: LH, HL, HH.
- Streams are band-major: all of band 0's streams, then band 1's, then band 2's.

Each stream starts with a mode byte:

| Mode | Meaning |
|---|---|
| `5` | Empty: every coefficient is 0. The stream is just this byte. |
| `6` | Run-length words |
| `2` | Huffman-coded run-length symbols |

A stream decodes to exactly `pw × ph` coefficients, row by row, where `pw` and `ph` are the block's extent within its record (64×64 except at the right and bottom edges).

### Mode 6: run-length words

The payload is a sequence of u16 little-endian words. The top two bits are a tag; the low 14 bits a magnitude `m`:

| Tag | Meaning |
|---|---|
| `00` | One coefficient, `+m` |
| `01` | One coefficient, `−m` |
| `10` | `m` zeros |
| `11` | Not used |

The stream ends exactly when the block's coefficient count is reached.

### Mode 2: Huffman-coded symbols

1. u16 LE `N`: the number of nodes in the code tree.
2. `N` tree tokens in pre-order (node, then its left subtree, then its right subtree):
   - `0x00`: an internal node.
   - `0x80` followed by a u16 LE word: a leaf holding a mode-6 word.
   - `0x4v`: a leaf for `+v` (v from 1 to 15).
   - `0x5v`: a leaf for `−v`.
   - `0x6v`: a leaf for `v` zeros.
3. The code bits, read least-significant bit first within each byte. Bit `0` goes left, `1` goes right.

Decode leaves until the block's coefficient count is reached; it always ends on a leaf. A tree with a single leaf repeats that leaf. The encoder leaves 8 to 15 unused bits at the end.

## Reconstruction

The image is rebuilt one level at a time with an inverse wavelet. For each band:

- **Image level 0** is record 0's LL coefficients multiplied by record 0's step for the band (1 in every real file seen).
- **Image level j + 1** is synthesised from image level j (as LL) and record j's LH, HL and HH coefficients, each multiplied by that record's step for the band. The result is twice the size, cropped to record j + 1's size, or to the full image size for the last level.

In the YUV colour space, band 0 is luma and bands 1 and 2 are chroma.

### Synthesis

The 1-D step, with indices clamped to the edges of the record:

```
even  x[2k]   = s[k] − (d[k−1] + d[k]) / 2
odd   x[2k+1] = (s[k] + s[k+1]) / 2 + d[k]
```

It runs over columns first (LL with LH, HL with HH), then over rows (the two column results as `s` and `d`). The SDK's exact arithmetic adds four rules:

1. **Quarter flooring.** For output pixels in an odd row *and* an odd column, the vertical averages `(s[k] + s[k+1]) / 2` from the column pass are floored to multiples of 1/4 before the row pass. Every other pixel uses exact arithmetic.
2. **Empty streams switch subbands off.** Each output pixel `(x, y)` belongs to the block holding coefficient `(x >> 1, y >> 1)`. If that block's stream for a subband is empty (mode 5) for this band, the subband contributes nothing to the pixel. That includes coefficients from neighbouring blocks that the filter would otherwise reach across the block edge.
3. **Exact path.** If all three detail streams of the band are empty in the pixel's block, the pixel is pure LL interpolation with no quarter flooring.
4. **Stored precision.** Every image level that feeds another synthesis is floored to multiples of 1/8. The level being output only needs flooring to integers (below), so flooring it to 1/8 first changes nothing.

### Colour

For YUV files (colour space 2), Y (band 0), Cb (band 1) and Cr (band 2) are each floored to an integer, then:

```
R = Y + T_R(Cr)
G = Y + T_GB(Cb) + T_GR(Cr)
B = Y + T_B(Cb)
```

Each result is clamped to 0 to 255. Each table is `T(c) = floor(k·c + offset + 0.5)`:

| Table | k | offset |
|---|---|---|
| `T_R` | 1.40228 | 1.011 |
| `T_B` | 1.77151 | 1.0075 |
| `T_GB` | −0.34349 | −0.0075 |
| `T_GR` | −0.71464 | −0.03 |

These are close to BT.601 but not equal, and the offsets mean all-zero data decodes to (1, 0, 1). They reproduce every table entry the SDK produces.

## Notes for comparing with GDAL

- GDAL's overview `k` is image level `k`, but sized by `floor` where the level table uses `ceil`.
- GDAL doesn't list the coarsest stored level as an overview. Its coarsest overview is image level 1 sampled at even pixels.
- Reading at reduced resolution, GDAL takes the nearest pixel of the next finer level.
- ECW version 2 has no alpha band. Areas outside the imaged footprint are lossy near-black (values 0 to 2), not exact zeros.
- By default GDAL presents every file north-up (negative Y cell size); its `ECW_ALWAYS_UPWARD` option exists for the rare file stored the other way.

## Unknowns

- Header bytes `0x02`, `0x05` and `0x10`, and the block index flag byte at `E + 4`. Byte `0x05` must be 4 for the SDK to decode a 3-band file.
- Real (not constructed) files with other than 3 bands, other block sizes, and ECW version 3.
