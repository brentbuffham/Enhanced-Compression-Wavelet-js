# Changelog

## Unreleased

- Package scaffold and test harness.
- `openEcw` reads the ECW v2 header, georeferencing and resolution-level table.
- `pixelWindowToBounds`, `EcwError` with stable codes, `MemorySource`, `BlobSource`.
- `readRegion` decodes imagery: block index, mode 2/5/6 streams, per-band dequantisation, windowed inverse wavelet, BT.601 colour. Within a few grey levels of the ECW SDK.
- Demo page with drag-and-drop, block-size map, OPFS keep-in-browser, and decoded imagery.
