// test/cache/BlockCache.test.js
//==========================================================
// Reconstructed-tile cache: in-memory LRU plus an optional OPFS tier
// (fake OPFS root) keyed by file fingerprint, level and tile.
// Tiles at eighths are held as Int16; anything else as Float32.
// OPFS tiles are written in pack files on flush().
// Run with: node --test test/cache/BlockCache.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BlockCache, fileFingerprint, blockCacheUsage, clearBlockCache, CACHE_DIR } from "../../src/cache/BlockCache.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";

// A width x height, 3-band tile of eighths whose values encode a seed
function tile(width, height, seed, step) {
	var bands = [0, 1, 2].map(function (b) {
		var a = new Float32Array(width * height);
		for (var i = 0; i < a.length; i++) a[i] = seed + b * 100 - i * (step || 1 / 8);
		return a;
	});
	return { width: width, height: height, bands: bands };
}
function same(a, b) {
	assert.equal(a.width, b.width);
	assert.equal(a.height, b.height);
	for (var i = 0; i < 3; i++) assert.deepEqual(Array.from(a.bands[i]), Array.from(b.bands[i]));
}
var TILE_BYTES = 4 * 4 * 3 * 2; // a 4x4, 3-band tile held as Int16 eighths

async function packNames(root, fingerprint) {
	var dir = await (await root.getDirectoryHandle(CACHE_DIR)).getDirectoryHandle(fingerprint);
	var names = [];
	for await (var h of dir.values()) names.push(h.name);
	return { dir: dir, names: names.sort() };
}

test("memory tier: get returns what put stored, keyed by level and tile", async function () {
	var c = new BlockCache({ tileSize: 4 });
	assert.equal(c.tileSize, 4);
	await c.put(2, 0, 1, tile(4, 4, 7));
	same(await c.get(2, 0, 1), tile(4, 4, 7));
	assert.equal(await c.get(2, 1, 0), null);
	assert.equal(await c.get(3, 0, 1), null);
});

test("eighths are held compactly; other values round-trip exactly as Float32", async function () {
	var c = new BlockCache({ tileSize: 4 });
	await c.put(1, 0, 0, tile(4, 4, 7));
	assert.equal(c.stats().memoryBytes, TILE_BYTES);
	await c.put(1, 1, 0, tile(4, 4, 7, 1 / 64));
	same(await c.get(1, 1, 0), tile(4, 4, 7, 1 / 64));
	await c.put(1, 2, 0, tile(4, 4, 5000));
	same(await c.get(1, 2, 0), tile(4, 4, 5000));
	assert.equal(c.stats().memoryBytes, TILE_BYTES * 5);
});

test("memory tier evicts the least recently used tile past memoryBytes", async function () {
	var c = new BlockCache({ tileSize: 4, memoryBytes: TILE_BYTES * 2 });
	await c.put(1, 0, 0, tile(4, 4, 1));
	await c.put(1, 1, 0, tile(4, 4, 2));
	await c.get(1, 0, 0); // touch: (1,0,0) is now most recent
	await c.put(1, 2, 0, tile(4, 4, 3));
	assert.ok(await c.get(1, 0, 0));
	assert.equal(await c.get(1, 1, 0), null);
	assert.ok(await c.get(1, 2, 0));
	assert.equal(c.stats().memoryBytes, TILE_BYTES * 2);
});

test("OPFS tier: flushed tiles serve a new cache with the same fingerprint", async function () {
	var root = createFakeRoot();
	var a = new BlockCache({ tileSize: 4, fingerprint: "fp1", opfs: { root: root } });
	await a.put(3, 2, 1, tile(4, 3, 9));
	await a.put(3, 3, 1, tile(4, 3, 7, 1 / 64));
	await a.flush();
	assert.equal((await packNames(root, "fp1")).names.length, 1, "one pack per flush");
	var b = new BlockCache({ tileSize: 4, fingerprint: "fp1", opfs: { root: root } });
	same(await b.get(3, 2, 1), tile(4, 3, 9));
	same(await b.get(3, 3, 1), tile(4, 3, 7, 1 / 64));
	assert.equal(b.stats().opfsHits, 2);
	var other = new BlockCache({ tileSize: 4, fingerprint: "fp2", opfs: { root: root } });
	assert.equal(await other.get(3, 2, 1), null);
});

test("unflushed tiles are written once enough are pending", async function () {
	var root = createFakeRoot();
	var c = new BlockCache({ tileSize: 4, fingerprint: "fp", opfs: { root: root, flushBytes: TILE_BYTES * 2 } });
	await c.put(1, 0, 0, tile(4, 4, 1));
	await c.put(1, 1, 0, tile(4, 4, 2));
	assert.equal((await packNames(root, "fp")).names.length, 1);
});

test("OPFS tier deletes the oldest packs past maxBytes, also across sessions", async function () {
	var root = createFakeRoot();
	var opts = { tileSize: 4, fingerprint: "fp", memoryBytes: 0, opfs: { root: root, maxBytes: 0 } };
	var a = new BlockCache(opts);
	await a.put(1, 0, 0, tile(4, 4, 1));
	await a.flush();
	var packBytes = (await blockCacheUsage({ root: root }))[0].bytes;
	opts.opfs.maxBytes = packBytes * 2;
	a = new BlockCache(opts);
	await a.put(1, 1, 0, tile(4, 4, 2));
	await a.flush();
	var b = new BlockCache(opts);
	await b.put(1, 2, 0, tile(4, 4, 3));
	await b.flush();
	assert.deepEqual(await blockCacheUsage({ root: root }), [{ fingerprint: "fp", tiles: 2, bytes: packBytes * 2 }]);
	var c = new BlockCache(opts);
	assert.equal(await c.get(1, 0, 0), null);
	assert.ok(await c.get(1, 1, 0));
	assert.ok(await c.get(1, 2, 0));
});

test("a corrupt pack or a different tile size is a miss, not an error", async function () {
	var root = createFakeRoot();
	var a = new BlockCache({ tileSize: 4, fingerprint: "fp", opfs: { root: root } });
	await a.put(1, 0, 0, tile(4, 4, 1));
	await a.flush();
	var c8 = new BlockCache({ tileSize: 8, fingerprint: "fp", opfs: { root: root } });
	assert.equal(await c8.get(1, 0, 0), null);
	var packs = await packNames(root, "fp");
	var sync = await (await packs.dir.getFileHandle(packs.names[0])).createSyncAccessHandle();
	sync.truncate(10);
	sync.close();
	var b = new BlockCache({ tileSize: 4, fingerprint: "fp", opfs: { root: root } });
	assert.equal(await b.get(1, 0, 0), null);
	await b.put(1, 1, 0, tile(4, 4, 2));
	await b.flush();
	assert.ok(await new BlockCache({ tileSize: 4, fingerprint: "fp", opfs: { root: root } }).get(1, 1, 0));
});

test("clearBlockCache removes every cached tile", async function () {
	var root = createFakeRoot();
	var c = new BlockCache({ tileSize: 4, fingerprint: "fp", opfs: { root: root } });
	await c.put(1, 0, 0, tile(4, 4, 1));
	await c.flush();
	await clearBlockCache({ root: root });
	assert.deepEqual(await blockCacheUsage({ root: root }), []);
});

test("fileFingerprint changes with name, size, date or the first bytes", async function () {
	var bytes = new Uint8Array(5000).map(function (_, i) { return i % 251; });
	var base = await fileFingerprint(new File([bytes], "a.ecw", { lastModified: 1000 }));
	assert.match(base, /^[0-9a-f]{16}$/);
	assert.equal(await fileFingerprint(new File([bytes], "a.ecw", { lastModified: 1000 })), base);
	assert.notEqual(await fileFingerprint(new File([bytes], "b.ecw", { lastModified: 1000 })), base);
	assert.notEqual(await fileFingerprint(new File([bytes], "a.ecw", { lastModified: 2000 })), base);
	assert.notEqual(await fileFingerprint(new File([bytes.subarray(0, 4999)], "a.ecw", { lastModified: 1000 })), base);
	var changed = bytes.slice();
	changed[100] ^= 1;
	assert.notEqual(await fileFingerprint(new File([changed], "a.ecw", { lastModified: 1000 })), base);
});
