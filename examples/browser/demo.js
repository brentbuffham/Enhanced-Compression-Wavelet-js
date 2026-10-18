// examples/browser/demo.js
//==========================================================
// Demo page wiring: drop/open a file, run Worker jobs with a
// progress bar, render info, stats and the block-size map, and
// drive every library function from the side panel. Each action
// writes the library call it made into "How it works".
//==========================================================

import { openEcw, pixelWindowToBounds, applyTransparency, clipToPolygon, listScratchFiles, getScratchFile, removeScratchFile, sweepStaleScratchFiles } from "../../src/index.js";
import { blockSizeColor, sizeRange } from "./lib/colorScale.js";
import { levelPictureBounds, KEPT_DIR } from "./lib/demoCore.js";
import { Viewer } from "./viewer.js";

var $ = function (id) { return document.getElementById(id); };

var worker = null;
var jobId = 0;
var pending = new Map();
var file = null;
var reader = null;
var opened = null;
var currentLevel = null;
var basePicture = null;
var hoverTimer = 0;
var lastHoverBlock = -1;
var blockSizes = null;

var viewer = new Viewer($("viewer"), { onHover: onHover, onPolygon: onPolygon, onViewChange: refineView });
var imageMode = false;
var refineSeq = 0;
var refineBusy = false;
var refinePending = false;

//----------------------------------------------------------
// Worker jobs
//----------------------------------------------------------

function startWorker() {
	if (worker) worker.terminate();
	pending.forEach(function (job) { job.reject(Object.assign(new Error("cancelled"), { code: "ABORTED" })); });
	pending.clear();
	worker = new Worker(new URL("./demoWorker.js", import.meta.url), { type: "module" });
	worker.onmessage = function (event) {
		var msg = event.data;
		var job = pending.get(msg.id);
		if (!job) return;
		if (msg.type === "progress") {
			if (!job.quiet) setProgress(msg.fraction, msg.label);
			return;
		}
		pending.delete(msg.id);
		if (msg.type === "result") job.resolve(msg.result);
		else job.reject(Object.assign(new Error(msg.message), { code: msg.code }));
	};
}

function run(type, payload, quiet) {
	return new Promise(function (resolve, reject) {
		var id = ++jobId;
		pending.set(id, { resolve: resolve, reject: reject, quiet: quiet });
		worker.postMessage({ id: id, type: type, payload: payload });
	});
}

//----------------------------------------------------------
// Status bar, stats, "How it works"
//----------------------------------------------------------

function setProgress(fraction, label) {
	$("progress").value = fraction;
	$("progressLabel").textContent = label;
	$("progressLabel").classList.remove("error");
}

function setError(err) {
	$("progress").value = 0;
	$("progressLabel").textContent = (err.code ? err.code + ": " : "") + err.message;
	$("progressLabel").classList.add("error");
}

function setStats(extra) {
	var s = opened.stats;
	var i = opened.info;
	var parts = [
		["size", i.width.toLocaleString() + " × " + i.height.toLocaleString()],
		["bands", i.bands],
		["levels", i.levels.length],
		["blocks", s.blockCount.toLocaleString()],
		["ratio", s.compressionRatio.toFixed(1) + ":1"],
		["file", formatBytes(opened.fileSize)]
	];
	if (extra) parts.push(extra);
	$("stats").innerHTML = parts.map(function (p) { return "<span>" + p[0] + " <b>" + p[1] + "</b></span>"; }).join("");
}

function formatBytes(n) {
	var units = ["B", "KB", "MB", "GB"];
	var u = 0;
	while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
	return n.toFixed(u ? 1 : 0) + " " + units[u];
}

function summarise(value) {
	return JSON.stringify(value, function (key, v) {
		if (ArrayBuffer.isView(v)) return v.constructor.name + "(" + v.length + ")";
		if (typeof v === "number" && !Number.isInteger(v)) return Number(v.toPrecision(12));
		return v;
	}, 2);
}

function how(code, result) {
	$("howCode").textContent = code + (result === undefined ? "" : "\n// →\n" + summarise(result));
}

//----------------------------------------------------------
// Opening a file
//----------------------------------------------------------

async function openFileInDemo(f, fromKept) {
	file = f;
	opened = null;
	basePicture = null;
	lastHoverBlock = -1;
	viewer.clearPolygon();
	$("fileName").textContent = f.name + " (" + formatBytes(f.size) + ")";
	startWorker();
	setProgress(0, "opening");
	try {
		reader = await openEcw(f);
		opened = await run("open", { file: f });
	} catch (err) {
		setError(err);
		how("var ecw = await openEcw(file);", { error: err.code, message: err.message });
		return;
	}
	how("var ecw = await openEcw(file);\necw.info;", reader.info);
	$("viewerEmpty").classList.add("hidden");
	renderInfo();
	setStats();
	["levelSelect", "sampleButton", "drawButton", "clearPolygon", "applyClip", "resetClip", "readButton", "wholeButton"].forEach(function (id) { $(id).disabled = false; });
	var select = $("levelSelect");
	select.innerHTML = opened.grid.map(function (g) {
		var lv = opened.levels[g.level];
		return "<option value='" + g.level + "'>" + g.level + ": " + lv.width + "×" + lv.height + " (" + (g.cols * g.rows).toLocaleString() + " blocks)</option>";
	}).join("");
	// Finest level whose block map stays under ~600k pixels
	var start = 0;
	opened.grid.forEach(function (g, k) { if (g.cols * g.rows <= 600000) start = k; });
	select.value = String(start);
	await showLevel(start, true);
	fillWhole();
	await runRead();
	if ($("keepToggle").checked && !fromKept) await keepCurrent();
}

function renderInfo() {
	var i = reader.info;
	var bounds = pixelWindowToBounds(i, 0, 0, i.width, i.height);
	var rows = [
		["version", i.version], ["width", i.width], ["height", i.height], ["bands", i.bands],
		["block", i.blockWidth + " × " + i.blockHeight], ["compression target", i.compressionTarget],
		["cell size X", i.cellSizeX], ["cell size Y", i.cellSizeY], ["origin X", i.originX], ["origin Y", i.originY],
		["datum", i.datum || "—"], ["projection", i.projection || "—"],
		["bounds minX", bounds.minX], ["bounds minY", bounds.minY], ["bounds maxX", bounds.maxX], ["bounds maxY", bounds.maxY],
		["block index", opened.index.entryCount.toLocaleString() + " entries"], ["data starts", "0x" + opened.index.dataStart.toString(16)]
	];
	$("infoEmpty").classList.add("hidden");
	$("infoTable").innerHTML = rows.map(function (r) { return "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>"; }).join("");
	renderLevelTable();
}

function renderLevelTable() {
	$("levelTable").innerHTML = "<tr><th>level</th><th>size</th><th>blocks</th></tr>" + i_levels().map(function (row) {
		return "<tr" + (row.level === currentLevel ? " class='current'" : "") + "><td>" + row.label + "</td><td>" + row.size + "</td><td>" + row.blocks + "</td></tr>";
	}).join("");
}

function i_levels() {
	var rows = opened.grid.map(function (g) {
		var lv = opened.levels[g.level];
		return { level: g.level, label: g.level, size: lv.width + "×" + lv.height, blocks: (g.cols * g.rows).toLocaleString() };
	});
	rows.push({ level: -1, label: "full", size: reader.info.width + "×" + reader.info.height, blocks: "from level " + (opened.grid.length - 1) });
	return rows;
}

//----------------------------------------------------------
// Blocks tab
//----------------------------------------------------------

async function showLevel(level, statsOnly) {
	currentLevel = level;
	renderLevelTable();
	var result;
	try {
		result = await run("levelBlocks", { level: level });
	} catch (err) {
		if (err.code !== "ABORTED") setError(err);
		return;
	}
	var range = sizeRange(result.sizes);
	var rgba = new Uint8ClampedArray(result.cols * result.rows * 4);
	var total = 0;
	for (var i = 0; i < result.sizes.length; i++) {
		var c = blockSizeColor(result.sizes[i], range.minLog, range.maxLog);
		rgba[i * 4] = c[0];
		rgba[i * 4 + 1] = c[1];
		rgba[i * 4 + 2] = c[2];
		rgba[i * 4 + 3] = 255;
		total += result.sizes[i];
	}
	var bounds = levelPictureBounds(reader.info, opened.header, opened.grid[level]);
	blockSizes = { cols: result.cols, rows: result.rows, sizes: result.sizes };
	if (!statsOnly) {
		imageMode = false;
		basePicture = { rgba: rgba, width: result.cols, height: result.rows, bounds: bounds, sizes: result.sizes };
		viewer.setPicture({ rgba: rgba.slice(), width: result.cols, height: result.rows, bounds: bounds });
	}
	$("levelStats").innerHTML = [
		["blocks", result.sizes.length.toLocaleString()],
		["bytes", formatBytes(total)],
		["mean / block", formatBytes(total / result.sizes.length)],
		["smallest", formatBytes(Math.exp(range.minLog))],
		["largest", formatBytes(Math.exp(range.maxLog))]
	].map(function (r) { return "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>"; }).join("");
	how("var index = parseBlockIndex(source, header);\nvar grid = blockGrid(header, levels);\nvar win = levelEntryWindow(index, grid[" + level + "]);\n// read win.start..win.end once, diff consecutive u64 offsets",
		{ level: level, cols: result.cols, rows: result.rows, bytes: total });
}

async function sampleLevel() {
	var count = Math.max(1, Number($("sampleCount").value) || 300);
	try {
		var s = await run("sample", { level: currentLevel, count: count });
		$("levelStats").insertAdjacentHTML("beforeend", [
			["sampled", s.sampled],
			["mode 2 streams", s.modes[2]],
			["mode 6 streams", s.modes[6]],
			["empty streams", (s.emptyShare * 100).toFixed(1) + "%"]
		].map(function (r) { return "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>"; }).join(""));
		setStats(["empty streams", (s.emptyShare * 100).toFixed(0) + "%"]);
		how("// for evenly spaced blocks n in level " + currentLevel + ":\nvar r = blockByteRange(index, n, entryBytes, file.size);\nvar streams = splitBlockStreams(blockBytes, info.bands, " + currentLevel + ");", s);
	} catch (err) {
		if (err.code !== "ABORTED") setError(err);
	}
}

function onHover(hit) {
	var hud = $("hud");
	if (!hit || !opened || currentLevel === null) {
		hud.textContent = "";
		return;
	}
	var g = opened.grid[currentLevel];
	var n = g.firstBlock + hit.py * g.cols + hit.px;
	var mapText = "x " + hit.map.x.toFixed(2) + "  y " + hit.map.y.toFixed(2);
	if (!basePicture || !basePicture.sizes) {
		hud.textContent = mapText;
		return;
	}
	var size = basePicture.sizes[hit.py * g.cols + hit.px];
	hud.textContent = mapText + "  ·  block " + n + " (row " + hit.py + ", col " + hit.px + ")  " + formatBytes(size);
	if (n === lastHoverBlock || document.querySelector(".tab.active").dataset.tab !== "blocks") return;
	clearTimeout(hoverTimer);
	hoverTimer = setTimeout(function () { inspect(n); }, 120);
}

async function inspect(n) {
	lastHoverBlock = n;
	try {
		var b = await run("inspect", { n: n }, true);
		$("blockDetail").classList.remove("muted");
		$("blockDetail").innerHTML = "<table class='kv'><tr><td>block</td><td>" + b.n + "</td></tr><tr><td>level / row / col</td><td>" + b.level + " / " + b.row + " / " + b.col +
			"</td></tr><tr><td>bytes</td><td>0x" + b.start.toString(16) + " + " + (b.end - b.start) + "</td></tr></table>" +
			"<table class='grid-table'><tr><th>band</th><th>subband</th><th>mode</th><th>bytes</th></tr>" +
			b.streams.map(function (s) { return "<tr class='mode-" + s.mode + "'><td>" + s.band + "</td><td>" + s.subband + "</td><td>" + s.mode + "</td><td>" + s.length + "</td></tr>"; }).join("") + "</table>";
		how("var win = blockEntryWindow(index, " + n + ");\nvar r = blockByteRange(index, " + n + ", entryBytes, file.size);\nsplitBlockStreams(blockBytes, info.bands, " + b.level + ");", b.streams);
	} catch (err) {
		if (err.code !== "ABORTED") $("blockDetail").textContent = err.message;
	}
}

//----------------------------------------------------------
// Clip tab
//----------------------------------------------------------

function onPolygon(points) {
	how("// polygon ring in map coordinates\nvar ring = " + JSON.stringify(points.map(function (p) { return [Number(p[0].toFixed(2)), Number(p[1].toFixed(2))]; })) + ";");
	$("drawButton").classList.remove("active");
}

function applyPostSteps() {
	if (!basePicture) return;
	var rgba = basePicture.rgba.slice();
	var threshold = Number($("thresholdInput").value);
	var calls = [];
	try {
		if ($("thresholdInput").value !== "") {
			applyTransparency(rgba, threshold);
			calls.push("applyTransparency(rgba, " + threshold + ");");
		}
		if (viewer.polygon.length >= 3) {
			clipToPolygon(rgba, basePicture.width, basePicture.height, basePicture.bounds, [viewer.polygon]);
			calls.push("clipToPolygon(rgba, " + basePicture.width + ", " + basePicture.height + ", bounds, [ring]);");
		}
	} catch (err) {
		setError(err);
		return;
	}
	var cleared = 0;
	for (var i = 3; i < rgba.length; i += 4) if (rgba[i] === 0) cleared++;
	viewer.setPicture({ rgba: rgba, width: basePicture.width, height: basePicture.height, bounds: basePicture.bounds, smooth: basePicture.smooth }, true);
	how(calls.join("\n") || "// nothing to apply", { transparentPixels: cleared, of: rgba.length / 4 });
}

//----------------------------------------------------------
// Zoom refinement: decode the visible area at screen resolution
//----------------------------------------------------------

async function refineView() {
	if (!imageMode || !reader) return;
	if (refineBusy) { refinePending = true; return; }
	var vis = viewer.visible();
	if (!vis) return;
	var i = reader.info;
	// Visible map bounds -> full-resolution pixel window, clamped to the image
	var x0 = Math.max(0, Math.floor((vis.bounds.minX - i.originX) / i.cellSizeX));
	var x1 = Math.min(i.width, Math.ceil((vis.bounds.maxX - i.originX) / i.cellSizeX));
	var y0 = Math.max(0, Math.floor((vis.bounds.maxY - i.originY) / i.cellSizeY));
	var y1 = Math.min(i.height, Math.ceil((vis.bounds.minY - i.originY) / i.cellSizeY));
	if (x1 <= x0 || y1 <= y0) return;
	// Screen pixels the window covers; never ask for more than full resolution
	var screenPerPixel = vis.width / ((vis.bounds.maxX - vis.bounds.minX) / i.cellSizeX);
	var outW = Math.min(x1 - x0, Math.ceil((x1 - x0) * screenPerPixel));
	var outH = Math.min(y1 - y0, Math.ceil((y1 - y0) * screenPerPixel));
	// The overview is already sharp enough: drop any detail layer
	var basePerPixel = basePicture.width / i.width;
	if (outW / (x1 - x0) <= basePerPixel * 1.05) { viewer.clearDetail(); return; }
	var scale = Math.min(1, 4096 / Math.max(outW, outH));
	outW = Math.max(1, Math.round(outW * scale));
	outH = Math.max(1, Math.round(outH * scale));
	var seq = ++refineSeq;
	refineBusy = true;
	var t0 = performance.now();
	try {
		var img = await run("read", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, outWidth: outW, outHeight: outH, resample: $("readResample").value }, true);
		if (seq === refineSeq) {
			viewer.setDetail({ rgba: img.data, width: img.width, height: img.height, bounds: img.bounds });
			setProgress(1, "detail " + img.width + "×" + img.height + " from level " + img.level + " in " + Math.round(performance.now() - t0) + " ms");
		}
	} catch (err) {
		if (err.code !== "ABORTED") setError(err);
	} finally {
		refineBusy = false;
		if (refinePending) { refinePending = false; refineView(); }
	}
}

//----------------------------------------------------------
// Read tab
//----------------------------------------------------------

function fillWhole() {
	var i = reader.info;
	var wrap = $("viewerWrap");
	var fit = Math.min(1, Math.max(wrap.clientWidth, 800) * (window.devicePixelRatio || 1) / i.width, Math.max(wrap.clientHeight, 500) * (window.devicePixelRatio || 1) / i.height);
	$("readX").value = 0;
	$("readY").value = 0;
	$("readW").value = i.width;
	$("readH").value = i.height;
	$("readOutW").value = Math.max(1, Math.round(i.width * fit));
	$("readOutH").value = Math.max(1, Math.round(i.height * fit));
}

async function runRead() {
	var opts = {
		x: Number($("readX").value), y: Number($("readY").value),
		width: Number($("readW").value), height: Number($("readH").value),
		outWidth: Number($("readOutW").value), outHeight: Number($("readOutH").value),
		resample: $("readResample").value
	};
	var code = "var img = await ecw.readRegion(" + JSON.stringify(opts) + ");";
	var t0 = performance.now();
	try {
		var img = await run("read", opts);
		basePicture = { rgba: img.data, width: img.width, height: img.height, bounds: img.bounds, smooth: true };
		viewer.setPicture({ rgba: img.data.slice(), width: img.width, height: img.height, bounds: img.bounds, smooth: true });
		imageMode = true;
		setProgress(1, "decoded " + img.width + "×" + img.height + " from level " + img.level + " in " + Math.round(performance.now() - t0) + " ms");
		how(code, { width: img.width, height: img.height, level: img.level, bounds: img.bounds });
	} catch (err) {
		how(code, { error: err.code, message: err.message });
		if (err.code !== "ABORTED") setError(err);
	}
}

//----------------------------------------------------------
// Scratch tab (OPFS)
//----------------------------------------------------------

async function keepCurrent() {
	try {
		var kept = await run("keep", { name: file.name });
		how("// in the worker: stream the File into OPFS\nvar w = await openScratchSyncWriter(" + JSON.stringify(file.name) + ", { dir: \"" + KEPT_DIR + "\" });\nfor await (var chunk of file.stream()) w.write(chunk);\nw.close();", kept);
		if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
	} catch (err) {
		if (err.code !== "ABORTED") setError(err);
	}
	refreshScratch();
}

function fileTable(files, actions) {
	if (!files.length) return null;
	return "<table class='grid-table file-list'><tr><th>name</th><th>size</th><th></th></tr>" + files.map(function (f) {
		return "<tr><td style='text-align:left;word-break:break-all'>" + f.name.replace(/</g, "&lt;") + "</td><td>" + formatBytes(f.size) + "</td><td>" +
			actions.map(function (a) { return "<button class='button' data-action='" + a + "' data-name='" + encodeURIComponent(f.name) + "'>" + a + "</button>"; }).join(" ") + "</td></tr>";
	}).join("") + "</table>";
}

async function refreshScratch() {
	try {
		var kept = await listScratchFiles({ dir: KEPT_DIR });
		var scratch = await listScratchFiles();
		$("keptList").innerHTML = fileTable(kept, ["open", "delete"]) || "None yet. Tick \"Keep in browser\" and open a file.";
		$("keptList").classList.toggle("muted", !kept.length);
		$("scratchList").innerHTML = fileTable(scratch, ["delete"]) || "None.";
		$("scratchList").classList.toggle("muted", !scratch.length);
		var rows = [["kept files", kept.length], ["scratch files", scratch.length]];
		if (navigator.storage && navigator.storage.estimate) {
			var est = await navigator.storage.estimate();
			rows.push(["origin storage used", formatBytes(est.usage || 0)], ["quota", formatBytes(est.quota || 0)]);
		}
		$("storageTable").innerHTML = rows.map(function (r) { return "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>"; }).join("");
		return { kept: kept, scratch: scratch };
	} catch (err) {
		$("storageTable").innerHTML = "<tr><td>OPFS</td><td class='error'>" + err.message + "</td></tr>";
	}
}

async function onScratchClick(event, dir) {
	var button = event.target.closest("button[data-action]");
	if (!button) return;
	var name = decodeURIComponent(button.dataset.name);
	var opts = dir ? { dir: dir } : undefined;
	try {
		if (button.dataset.action === "open") {
			var f = await getScratchFile(name, opts);
			how("var file = await getScratchFile(" + JSON.stringify(name) + ", { dir: \"" + KEPT_DIR + "\" });\nvar ecw = await openEcw(file);");
			await openFileInDemo(f, true);
		} else {
			await removeScratchFile(name, opts);
			how("await removeScratchFile(" + JSON.stringify(name) + (dir ? ", { dir: \"" + dir + "\" }" : "") + ");");
		}
	} catch (err) {
		setError(err);
	}
	refreshScratch();
}

//----------------------------------------------------------
// Wiring
//----------------------------------------------------------

document.querySelectorAll(".tab").forEach(function (tab) {
	tab.addEventListener("click", function () {
		document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t === tab); });
		document.querySelectorAll(".tab-body").forEach(function (body) { body.classList.toggle("hidden", body.id !== "tab-" + tab.dataset.tab); });
	});
});

$("togglePanel").addEventListener("click", function () { document.querySelector(".layout").classList.toggle("panel-hidden"); });
$("fileInput").addEventListener("change", function (e) { if (e.target.files[0]) openFileInDemo(e.target.files[0]); });
$("levelSelect").addEventListener("change", function (e) { showLevel(Number(e.target.value)); });
$("sampleButton").addEventListener("click", sampleLevel);
$("drawButton").addEventListener("click", function () { viewer.startPolygon(); $("drawButton").classList.add("active"); });
$("clearPolygon").addEventListener("click", function () { viewer.clearPolygon(); $("drawButton").classList.remove("active"); });
$("applyClip").addEventListener("click", applyPostSteps);
$("resetClip").addEventListener("click", function () {
	if (basePicture) viewer.setPicture({ rgba: basePicture.rgba.slice(), width: basePicture.width, height: basePicture.height, bounds: basePicture.bounds, smooth: basePicture.smooth }, true);
});
$("readButton").addEventListener("click", runRead);
$("wholeButton").addEventListener("click", function () { fillWhole(); runRead(); });
$("keptList").addEventListener("click", function (e) { onScratchClick(e, KEPT_DIR); });
$("scratchList").addEventListener("click", function (e) { onScratchClick(e, null); });
$("refreshScratch").addEventListener("click", refreshScratch);
$("sweepButton").addEventListener("click", async function () {
	var removed = await sweepStaleScratchFiles();
	how("await sweepStaleScratchFiles(); // files older than 24 h", { removed: removed });
	refreshScratch();
});
try { $("keepToggle").checked = localStorage.getItem("ecw-demo-keep") === "1"; } catch (err) { /* storage blocked */ }
$("keepToggle").addEventListener("change", function (e) {
	try { localStorage.setItem("ecw-demo-keep", e.target.checked ? "1" : "0"); } catch (err) { /* storage blocked */ }
});
document.querySelector(".tab[data-tab='scratch']").addEventListener("click", refreshScratch);
refreshScratch();

var dragDepth = 0;
window.addEventListener("dragenter", function (e) { e.preventDefault(); dragDepth++; $("dropOverlay").classList.remove("hidden"); });
window.addEventListener("dragleave", function () { if (--dragDepth <= 0) { dragDepth = 0; $("dropOverlay").classList.add("hidden"); } });
window.addEventListener("dragover", function (e) { e.preventDefault(); });
window.addEventListener("drop", function (e) {
	e.preventDefault();
	dragDepth = 0;
	$("dropOverlay").classList.add("hidden");
	var f = e.dataTransfer.files[0];
	if (f) openFileInDemo(f);
});
