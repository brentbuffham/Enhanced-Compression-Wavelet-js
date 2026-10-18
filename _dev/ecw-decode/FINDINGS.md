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

## ⭐ CRACKED: level table

- Starts at `0x59`, `levelCount` records of 21 bytes: u8 level index, u32 BE width, u32 BE height, three u32 BE `a`, `b`, `c`.
- Coarsest first. Level `k` of `n` is `ceil(W / 2^(n-k))` × `ceil(H / 2^(n-k))`. Full resolution is not a record.
- Sample A: `a/b/c` stay at 1 for the coarsest levels, then grow with level. Meaning open.
- GDAL reports floor-sized overviews and omits the coarsest stored level. Its coarsest overview repeats every value in pairs: GDAL upsamples the next level down.

## Open: after the level table

- More bytes follow the table, then what looks like rising u64 LE offsets. Task 13 of the foundation plan works this out.

## Black / transparency

- ECW v2 has no alpha band. Off-footprint areas are lossy near-black (values 0–2, smeared at edges), not exact zeros.

## Ruled out (don't re-walk)

- (none yet)
