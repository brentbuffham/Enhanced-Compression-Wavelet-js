// src/cache/BlockCache.js
//==========================================================
// Cache of reconstructed level tiles (the decoder's expensive part:
// wavelet synthesis is ~2/3 of decode time, stream decoding ~3%).
// A tile is tileSize x tileSize pixels of image level j >= 1, every
// band. The decoder stores tiles floored to eighths (all that a level
// feeding the next one, or the final colour step, ever uses); those are
// held as Int16 (value * 8), anything else as Float32.
//   Memory tier: LRU bounded by memoryBytes (0 turns it off).
//   OPFS tier (opt-in): tiles are buffered and written together as
//     pack files in ecw-cache/<fingerprint>/ (one file write per ~8 MB,
//     not per tile), oldest packs deleted past maxBytes. Works on the
//     main thread (createWritable) and in Workers (sync access handles).
// Cache failures are never errors: a tile that cannot be read or
// written is simply recomputed.
// Tile record: "ECWT", u32 LE width, height, u16 bands, u16 kind
// (1 Int16 eighths, 2 Float32), then planes band after band (LE).
// Pack: tile records, then a UTF-8 JSON index {"v":1,"tiles":{key:
// [offset, length]}}, u32 LE index length, "ECWP".
//==========================================================

/** OPFS directory holding every ecw-js tile cache. */
export var CACHE_DIR = "ecw-cache";
// Bump whenever decoded pixel values change, so stale tiles are never reused
export var CACHE_VERSION = 1;

var DEFAULT_TILE_SIZE = 64;
var DEFAULT_MEMORY_BYTES = 256 * 1024 * 1024;
var DEFAULT_OPFS_BYTES = 512 * 1024 * 1024;
var DEFAULT_FLUSH_BYTES = 8 * 1024 * 1024;
var TILE_MAGIC = 0x54574345; // "ECWT" as u32 LE
var PACK_MAGIC = 0x50574345; // "ECWP" as u32 LE
var TILE_HEADER = 16;
var KIND_EIGHTHS = 1;
var KIND_FLOAT = 2;
var FINGERPRINT_BYTES = 4096;
// Whole packs read back are kept briefly: tiles of one pack come from one read
// and are usually wanted together, so this saves a file read per tile
var PACK_BUFFERS = 4;
// Typed-array views copy planes directly on little-endian hosts (all current ones)
var LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

//----------------------------------------------------------
// Tile encoding
//----------------------------------------------------------

// { width, height, kind, planes } with Int16 eighths when every value allows it
// (converted and checked in one pass), otherwise Float32 copies
function encodeTile(tile) {
	var planes = [];
	for (var b = 0; b < tile.bands.length; b++) {
		var band = tile.bands[b], out = new Int16Array(band.length);
		for (var i = 0; i < band.length; i++) {
			var v = band[i] * 8;
			out[i] = v;
			if (out[i] !== v) break;
		}
		if (i < band.length) {
			return { width: tile.width, height: tile.height, kind: KIND_FLOAT, planes: tile.bands.map(function (p) { return Float32Array.from(p); }) };
		}
		planes.push(out);
	}
	return { width: tile.width, height: tile.height, kind: KIND_EIGHTHS, planes: planes };
}

// The stored planes themselves (read-only for callers): value = band[i] * scale
function tileView(enc) {
	return { width: enc.width, height: enc.height, bands: enc.planes, scale: enc.kind === KIND_EIGHTHS ? 1 / 8 : 1 };
}

function encodedBytes(enc) {
	return enc.planes.reduce(function (n, p) { return n + p.byteLength; }, 0);
}

function tileRecord(enc) {
	var out = new Uint8Array(TILE_HEADER + encodedBytes(enc));
	var view = new DataView(out.buffer);
	view.setUint32(0, TILE_MAGIC, true);
	view.setUint32(4, enc.width, true);
	view.setUint32(8, enc.height, true);
	view.setUint16(12, enc.planes.length, true);
	view.setUint16(14, enc.kind, true);
	var at = TILE_HEADER;
	enc.planes.forEach(function (p) {
		if (LITTLE_ENDIAN) {
			out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at);
			at += p.byteLength;
			return;
		}
		for (var i = 0; i < p.length; i++, at += p.BYTES_PER_ELEMENT) {
			if (enc.kind === KIND_EIGHTHS) view.setInt16(at, p[i], true);
			else view.setFloat32(at, p[i], true);
		}
	});
	return out;
}

function readTileRecord(buffer) {
	if (buffer.byteLength < TILE_HEADER) return null;
	var view = new DataView(buffer);
	if (view.getUint32(0, true) !== TILE_MAGIC) return null;
	var width = view.getUint32(4, true), height = view.getUint32(8, true);
	var count = view.getUint16(12, true), kind = view.getUint16(14, true);
	var n = width * height, size = kind === KIND_EIGHTHS ? 2 : kind === KIND_FLOAT ? 4 : 0;
	if (!size || buffer.byteLength !== TILE_HEADER + count * n * size) return null;
	var planes = [], at = TILE_HEADER;
	for (var b = 0; b < count; b++) {
		var p = kind === KIND_EIGHTHS ? new Int16Array(n) : new Float32Array(n);
		if (LITTLE_ENDIAN) {
			new Uint8Array(p.buffer).set(new Uint8Array(buffer, at, n * size));
			at += n * size;
		} else {
			for (var i = 0; i < n; i++, at += size) p[i] = kind === KIND_EIGHTHS ? view.getInt16(at, true) : view.getFloat32(at, true);
		}
		planes.push(p);
	}
	return { width: width, height: height, kind: kind, planes: planes };
}

//----------------------------------------------------------
// Packs
//----------------------------------------------------------

function buildPack(entries) {
	var records = entries.map(function (e) { return tileRecord(e.enc); });
	var index = {}, offset = 0;
	entries.forEach(function (e, i) { index[e.key] = [offset, records[i].length]; offset += records[i].length; });
	var json = new TextEncoder().encode(JSON.stringify({ v: 1, tiles: index }));
	var out = new Uint8Array(offset + json.length + 8);
	offset = 0;
	records.forEach(function (r) { out.set(r, offset); offset += r.length; });
	out.set(json, offset);
	var view = new DataView(out.buffer);
	view.setUint32(offset + json.length, json.length, true);
	view.setUint32(offset + json.length + 4, PACK_MAGIC, true);
	return { bytes: out, index: index };
}

// The pack's index { key: [offset, length] }, or null when the file is not a whole pack
async function readPackIndex(file) {
	try {
		if (file.size < 8) return null;
		var tail = new DataView(await file.slice(file.size - 8).arrayBuffer());
		if (tail.getUint32(4, true) !== PACK_MAGIC) return null;
		var length = tail.getUint32(0, true);
		if (length > file.size - 8) return null;
		var parsed = JSON.parse(new TextDecoder().decode(await file.slice(file.size - 8 - length, file.size - 8).arrayBuffer()));
		return parsed && parsed.v === 1 && parsed.tiles ? parsed.tiles : null;
	} catch (err) {
		return null;
	}
}

async function writeFile(dir, name, bytes) {
	var handle = await dir.getFileHandle(name, { create: true });
	if (typeof handle.createSyncAccessHandle === "function") {
		var sync = await handle.createSyncAccessHandle();
		try {
			sync.truncate(0);
			sync.write(bytes, { at: 0 });
			sync.flush();
		} finally {
			sync.close();
		}
	} else {
		var writable = await handle.createWritable();
		await writable.write(bytes);
		await writable.close();
	}
	return handle.getFile();
}

async function cacheRoot(options, create) {
	var root = (options && options.root) || await navigator.storage.getDirectory();
	return root.getDirectoryHandle((options && options.dir) || CACHE_DIR, { create: create });
}

//----------------------------------------------------------
// BlockCache
//----------------------------------------------------------

/**
 * @param {{tileSize?:number, memoryBytes?:number, fingerprint?:string,
 *   opfs?:boolean|{root?:object, dir?:string, maxBytes?:number, flushBytes?:number}}} [options]
 *   fingerprint (fileFingerprint()) is required for the OPFS tier.
 */
export function BlockCache(options) {
	var o = options || {};
	this.tileSize = o.tileSize || DEFAULT_TILE_SIZE;
	this._memoryLimit = o.memoryBytes === undefined ? DEFAULT_MEMORY_BYTES : o.memoryBytes;
	this._memory = new Map();
	this._memoryBytes = 0;
	this._opfs = o.opfs && o.fingerprint
		? Object.assign({ maxBytes: DEFAULT_OPFS_BYTES, flushBytes: DEFAULT_FLUSH_BYTES }, o.opfs === true ? {} : o.opfs)
		: null;
	this._fingerprint = o.fingerprint || null;
	this._loaded = null;
	// OPFS state once loaded: packs oldest first [{name, size, file}], key -> {pack, offset, length}
	this._packs = [];
	this._index = new Map();
	this._pending = [];
	this._pendingBytes = 0;
	this._flushing = Promise.resolve();
	this._packCount = 0;
	this._packBuffers = new Map();
	this._stats = { hits: 0, misses: 0, opfsHits: 0 };
}

BlockCache.prototype._key = function (j, tx, ty) {
	return "L" + j + "_" + tx + "_" + ty + "_t" + this.tileSize;
};

/**
 * The cached tile, or null. Its bands are the cache's own storage (do not
 * modify): Int16 eighths with scale 1/8, or Float32 with scale 1.
 * @returns {Promise<{width:number, height:number, bands:(Int16Array|Float32Array)[], scale:number}|null>}
 */
BlockCache.prototype.get = async function (j, tx, ty) {
	var key = this._key(j, tx, ty);
	var hit = this._memory.get(key);
	if (hit) {
		this._memory.delete(key);
		this._memory.set(key, hit);
		this._stats.hits++;
		return tileView(hit);
	}
	if (this._opfs) {
		var enc = await this._readTile(key);
		if (enc) {
			this._stats.hits++;
			this._stats.opfsHits++;
			this._remember(key, enc);
			return tileView(enc);
		}
	}
	this._stats.misses++;
	return null;
};

/** Store a tile; OPFS writes are buffered until flushBytes are pending or flush(). */
BlockCache.prototype.put = async function (j, tx, ty, tile) {
	var key = this._key(j, tx, ty);
	var enc = encodeTile(tile);
	this._remember(key, enc);
	if (!this._opfs) return;
	this._pending.push({ key: key, enc: enc });
	this._pendingBytes += encodedBytes(enc);
	if (this._pendingBytes >= this._opfs.flushBytes) await this.flush();
};

/** Write pending tiles to OPFS as one pack. Resolves once written (or given up on). */
BlockCache.prototype.flush = function () {
	var self = this;
	if (!this._opfs) return Promise.resolve();
	this._flushing = this._flushing.then(function () { return self._writePack(); });
	return this._flushing;
};

/** @returns {{memoryTiles:number, memoryBytes:number, hits:number, misses:number, opfsHits:number}} */
BlockCache.prototype.stats = function () {
	return Object.assign({ memoryTiles: this._memory.size, memoryBytes: this._memoryBytes }, this._stats);
};

BlockCache.prototype._remember = function (key, enc) {
	var bytes = encodedBytes(enc);
	if (bytes > this._memoryLimit) return;
	var old = this._memory.get(key);
	if (old) {
		this._memoryBytes -= encodedBytes(old);
		this._memory.delete(key);
	}
	this._memory.set(key, enc);
	this._memoryBytes += bytes;
	for (var first of this._memory) {
		if (this._memoryBytes <= this._memoryLimit) break;
		this._memory.delete(first[0]);
		this._memoryBytes -= encodedBytes(first[1]);
	}
};

// Open the fingerprint directory and read every pack's index (oldest first)
BlockCache.prototype._load = function () {
	var self = this;
	if (!this._loaded) {
		this._loaded = (async function () {
			var dir = await (await cacheRoot(self._opfs, true)).getDirectoryHandle(self._fingerprint, { create: true });
			var names = [];
			for await (var handle of dir.values()) if (handle.kind === "file") names.push(handle.name);
			names.sort();
			for (var name of names) {
				var file = await (await dir.getFileHandle(name)).getFile();
				self._addPack(name, file, await readPackIndex(file));
			}
			return dir;
		})();
	}
	return this._loaded;
};

BlockCache.prototype._addPack = function (name, file, index) {
	this._packs.push({ name: name, size: file.size, file: file });
	if (!index) return;
	for (var key in index) this._index.set(key, { pack: name, offset: index[key][0], length: index[key][1] });
};

BlockCache.prototype._readTile = async function (key) {
	try {
		await this._load();
		var at = this._index.get(key);
		if (!at) return null;
		var pack = this._packs.find(function (p) { return p.name === at.pack; });
		if (!pack) return null;
		var buffer = this._packBuffers.get(pack.name);
		if (!buffer) {
			buffer = await pack.file.arrayBuffer();
			this._packBuffers.set(pack.name, buffer);
			if (this._packBuffers.size > PACK_BUFFERS) this._packBuffers.delete(this._packBuffers.keys().next().value);
		}
		// a copy, so the record starts aligned for typed-array views
		return readTileRecord(buffer.slice(at.offset, at.offset + at.length));
	} catch (err) {
		return null;
	}
};

BlockCache.prototype._writePack = async function () {
	if (!this._pending.length) return;
	var entries = this._pending;
	this._pending = [];
	this._pendingBytes = 0;
	try {
		var dir = await this._load();
		var pack = buildPack(entries);
		// names sort oldest first: time, then this instance's sequence
		var name = "pack-" + String(Date.now()).padStart(15, "0") + "-" + String(++this._packCount).padStart(6, "0") + "-" + Math.random().toString(36).slice(2, 8) + ".ecwp";
		this._addPack(name, await writeFile(dir, name, pack.bytes), pack.index);
		await this._evict(dir);
	} catch (err) {
		// best effort: storage full or blocked; the tiles stay in memory
	}
};

// Delete oldest packs while over maxBytes, never the newest
BlockCache.prototype._evict = async function (dir) {
	var total = this._packs.reduce(function (n, p) { return n + p.size; }, 0);
	while (total > this._opfs.maxBytes && this._packs.length > 1) {
		var old = this._packs.shift();
		this._packBuffers.delete(old.name);
		total -= old.size;
		for (var entry of Array.from(this._index)) if (entry[1].pack === old.name) this._index.delete(entry[0]);
		try {
			await dir.removeEntry(old.name);
		} catch (err) {
			// already gone, or open in another tab
		}
	}
};

//----------------------------------------------------------
// Fingerprint and housekeeping
//----------------------------------------------------------

// 32-bit FNV-1a over bytes, continuing from h
function fnv1a(h, bytes) {
	for (var i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h;
}

/**
 * Cache key for a file: its name, size, lastModified, first 4 KB and the
 * decoder's CACHE_VERSION, hashed to 16 hex digits.
 * @param {Blob} blob - A File or Blob.
 * @returns {Promise<string>}
 */
export async function fileFingerprint(blob) {
	var head = new Uint8Array(await blob.slice(0, FINGERPRINT_BYTES).arrayBuffer());
	var meta = new TextEncoder().encode([CACHE_VERSION, blob.name || "", blob.size, blob.lastModified || 0].join("|"));
	// two differently seeded passes give 64 bits
	var a = fnv1a(fnv1a(2166136261, meta), head);
	var b = fnv1a(fnv1a(0x811C9DC5 ^ 0x5BD1E995, head), meta);
	return ("00000000" + a.toString(16)).slice(-8) + ("00000000" + b.toString(16)).slice(-8);
}

/**
 * Tiles and bytes held in OPFS per file fingerprint.
 * @param {{root?:object, dir?:string}} [options]
 * @returns {Promise<Array<{fingerprint:string, tiles:number, bytes:number}>>}
 */
export async function blockCacheUsage(options) {
	var base;
	try {
		base = await cacheRoot(options, false);
	} catch (err) {
		if (err && err.name === "NotFoundError") return [];
		throw err;
	}
	var out = [];
	for await (var dir of base.values()) {
		if (dir.kind !== "directory") continue;
		var tiles = 0, bytes = 0;
		for await (var handle of dir.values()) {
			if (handle.kind !== "file") continue;
			var file = await handle.getFile();
			var index = await readPackIndex(file);
			tiles += index ? Object.keys(index).length : 0;
			bytes += file.size;
		}
		out.push({ fingerprint: dir.name, tiles: tiles, bytes: bytes });
	}
	return out;
}

/**
 * Delete every cached tile (all files' caches).
 * @param {{root?:object, dir?:string}} [options]
 */
export async function clearBlockCache(options) {
	var root = (options && options.root) || await navigator.storage.getDirectory();
	try {
		await root.removeEntry((options && options.dir) || CACHE_DIR, { recursive: true });
	} catch (err) {
		if (!err || err.name !== "NotFoundError") throw err;
	}
}
