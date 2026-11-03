// src/format/sidecars.js
//==========================================================
// Sidecar files that travel with an ECW: a world file (.eww, .ecww
// or .wld, six numbers) and a .prj holding the CRS as WKT (ESRI WKT1,
// OGC WKT1 or WKT2). Neither is part of the ECW; openEcw reads them
// only when the caller passes them in.
// A world file gives the centre of the top-left pixel; the ECW header
// and info.originX/Y give its top-left corner, so parseWorldFile
// returns both.
//==========================================================

import { EcwError, ERROR_CODES } from "../errors.js";

var WORLD_EXTENSIONS = ["eww", "ecww", "wld"];
var PRJ_EXTENSIONS = ["prj"];

function invalid(message) {
	return new EcwError(ERROR_CODES.INVALID_ARGUMENT, message);
}

/**
 * Parse a world file.
 * @param {string} text - Six numbers, one per line: A, D, B, E, C, F.
 * @returns {{cellSizeX:number, rotationY:number, rotationX:number, cellSizeY:number,
 *   centreX:number, centreY:number, originX:number, originY:number}}
 *   centreX/Y is the centre of the top-left pixel; originX/Y its top-left corner.
 */
export function parseWorldFile(text) {
	if (typeof text !== "string") throw invalid("world file must be text");
	var tokens = text.trim().split(/\s+/).filter(Boolean);
	if (tokens.length !== 6) throw invalid("world file needs 6 numbers, found " + tokens.length);
	var v = tokens.map(Number);
	v.forEach(function (n, i) { if (!Number.isFinite(n)) throw invalid("world file line " + (i + 1) + " is not a number: " + tokens[i]); });
	var a = v[0], d = v[1], b = v[2], e = v[3], c = v[4], f = v[5];
	return {
		cellSizeX: a, rotationY: d, rotationX: b, cellSizeY: e,
		centreX: c, centreY: f,
		originX: c - a / 2 - b / 2,
		originY: f - d / 2 - e / 2
	};
}

// WKT tree: { keyword, args: [string | number | node] }. Quoted strings stay
// strings ("" escapes a quote); bare words (EAST, Cartesian) are strings too.
function parseWkt(text) {
	var i = 0, n = text.length;
	function fail(message) { throw invalid("prj is not valid WKT: " + message + " at character " + i); }
	function space() { while (i < n && /\s/.test(text[i])) i++; }
	function word() {
		var s = i;
		while (i < n && /[A-Za-z0-9_.+\-]/.test(text[i])) i++;
		return text.slice(s, i);
	}
	function value() {
		space();
		if (text[i] === "\"") {
			var out = "";
			i++;
			for (;;) {
				if (i >= n) fail("unterminated string");
				if (text[i] === "\"") {
					if (text[i + 1] === "\"") { out += "\""; i += 2; continue; }
					i++;
					return out;
				}
				out += text[i++];
			}
		}
		var w = word();
		if (!w) fail("expected a value");
		space();
		if (text[i] === "[" || text[i] === "(") return node(w);
		var num = Number(w);
		return /^[+\-]?(\d|\.\d)/.test(w) && Number.isFinite(num) ? num : w;
	}
	function node(keyword) {
		var close = text[i] === "[" ? "]" : ")";
		i++;
		var args = [];
		space();
		if (text[i] === close) { i++; return { keyword: keyword.toUpperCase(), args: args }; }
		for (;;) {
			args.push(value());
			space();
			if (text[i] === ",") { i++; continue; }
			if (text[i] === close) { i++; break; }
			fail("expected , or " + close);
		}
		return { keyword: keyword.toUpperCase(), args: args };
	}
	space();
	var root = value();
	space();
	if (typeof root !== "object") fail("expected a keyword with [ ]");
	if (i < n) fail("unexpected text after the WKT");
	return root;
}

function children(nodeIn, keywords) {
	return nodeIn.args.filter(function (a) { return typeof a === "object" && keywords.indexOf(a.keyword) >= 0; });
}

function findDeep(nodeIn, keywords) {
	var direct = children(nodeIn, keywords)[0];
	if (direct) return direct;
	for (var k = 0; k < nodeIn.args.length; k++) {
		var a = nodeIn.args[k];
		if (typeof a === "object") {
			var hit = findDeep(a, keywords);
			if (hit) return hit;
		}
	}
	return null;
}

var CRS_TYPES = {
	PROJCS: "projected", PROJCRS: "projected", PROJECTEDCRS: "projected",
	GEOGCS: "geographic", GEOGCRS: "geographic", GEOGRAPHICCRS: "geographic", GEODCRS: "geographic", GEODETICCRS: "geographic", GEOCCS: "geocentric",
	LOCAL_CS: "local", ENGCRS: "local", ENGINEERINGCRS: "local",
	COMPD_CS: "compound", COMPOUNDCRS: "compound"
};
var UNIT_KEYWORDS = ["UNIT", "LENGTHUNIT", "ANGLEUNIT"];

function authorityCode(nodeIn) {
	var id = children(nodeIn, ["AUTHORITY", "ID"])[0];
	if (!id || String(id.args[0]).toUpperCase() !== "EPSG") return null;
	var code = Number(id.args[1]);
	return Number.isInteger(code) ? code : null;
}

/**
 * Parse a .prj (WKT1, ESRI WKT1 or WKT2). Reports what the WKT states and
 * nothing more: no names are mapped to EPSG codes.
 * @param {string} text
 * @returns {{wkt:string, type:string, name:string, datum:string|null, projection:string|null,
 *   units:string|null, unitFactor:number|null, epsg:number|null}}
 *   type is "projected", "geographic", "geocentric", "local", "compound" or the WKT keyword.
 *   For a compound CRS, datum, projection and units describe its first (horizontal) part.
 *   unitFactor is the unit's size in metres (or radians for an angular unit).
 */
export function parsePrj(text) {
	if (typeof text !== "string") throw invalid("prj must be text");
	var wkt = text.trim();
	var root = parseWkt(wkt);
	var type = CRS_TYPES[root.keyword] || root.keyword.toLowerCase();
	var horizontal = root;
	if (type === "compound") {
		horizontal = root.args.filter(function (a) { return typeof a === "object" && CRS_TYPES[a.keyword]; })[0] || root;
	}
	var datum = findDeep(horizontal, ["DATUM", "GEODETICDATUM", "TRF"]);
	var proj = children(horizontal, ["PROJECTION"])[0];
	var conversion = children(horizontal, ["CONVERSION"])[0];
	var method = conversion ? children(conversion, ["METHOD", "PROJECTION"])[0] : null;
	var unit = children(horizontal, UNIT_KEYWORDS)[0];
	if (!unit) {
		var axis = children(horizontal, ["AXIS", "CS"]).map(function (a) { return children(a, UNIT_KEYWORDS)[0]; }).filter(Boolean)[0];
		unit = axis || null;
	}
	var factor = unit ? Number(unit.args[1]) : NaN;
	return {
		wkt: wkt,
		type: type,
		name: typeof root.args[0] === "string" ? root.args[0] : "",
		datum: datum && typeof datum.args[0] === "string" ? datum.args[0] : null,
		projection: proj ? String(proj.args[0]) : method ? String(method.args[0]) : null,
		units: unit ? String(unit.args[0]) : null,
		unitFactor: Number.isFinite(factor) ? factor : null,
		epsg: authorityCode(root)
	};
}

function stems(name) {
	var lower = String(name).toLowerCase();
	var dot = lower.lastIndexOf(".");
	var base = dot > 0 ? lower.slice(0, dot) : lower;
	return [base, lower];
}

function splitName(name) {
	var lower = String(name).toLowerCase();
	var dot = lower.lastIndexOf(".");
	return dot > 0 ? { stem: lower.slice(0, dot), ext: lower.slice(dot + 1) } : { stem: lower, ext: "" };
}

/**
 * Pick the sidecars of an ECW from a list of files (a FileList or array),
 * matching by name: "site.ecw" pairs with site.eww / site.ecww / site.wld
 * (or site.ecw.wld) and site.prj (or site.ecw.prj), ignoring case.
 * @param {{name:string}} ecwFile
 * @param {Iterable<{name:string}>} files
 * @returns {{worldFile:object|null, prj:object|null}}
 */
export function pickSidecars(ecwFile, files) {
	var want = stems(ecwFile && ecwFile.name);
	var out = { worldFile: null, prj: null };
	Array.from(files || []).forEach(function (f) {
		if (!f || f === ecwFile) return;
		var p = splitName(f.name);
		if (want.indexOf(p.stem) < 0) return;
		if (!out.worldFile && WORLD_EXTENSIONS.indexOf(p.ext) >= 0) out.worldFile = f;
		if (!out.prj && PRJ_EXTENSIONS.indexOf(p.ext) >= 0) out.prj = f;
	});
	return out;
}
