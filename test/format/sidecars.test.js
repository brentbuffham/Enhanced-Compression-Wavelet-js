// test/format/sidecars.test.js
//==========================================================
// World file and .prj parsing, and matching sidecars to an ECW by name.
// Run with: node --test test/format/sidecars.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorldFile, parsePrj, pickSidecars } from "../../src/format/sidecars.js";

var ESRI_UTM = "PROJCS[\"WGS_1984_UTM_Zone_33N\",GEOGCS[\"GCS_WGS_1984\",DATUM[\"D_WGS_1984\",SPHEROID[\"WGS_1984\",6378137,298.257223563]]," +
	"PRIMEM[\"Greenwich\",0],UNIT[\"Degree\",0.017453292519943295]],PROJECTION[\"Transverse_Mercator\"],PARAMETER[\"false_easting\",500000]," +
	"PARAMETER[\"false_northing\",0],PARAMETER[\"central_meridian\",15],PARAMETER[\"scale_factor\",0.9996],PARAMETER[\"latitude_of_origin\",0],UNIT[\"Meter\",1]]";

var OGC_UTM = "PROJCS[\"WGS 84 / UTM zone 33N\",GEOGCS[\"WGS 84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS 84\",6378137,298.257223563,AUTHORITY[\"EPSG\",\"7030\"]]," +
	"AUTHORITY[\"EPSG\",\"6326\"]],PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433],AUTHORITY[\"EPSG\",\"4326\"]]," +
	"PROJECTION[\"Transverse_Mercator\"],PARAMETER[\"central_meridian\",15],UNIT[\"metre\",1,AUTHORITY[\"EPSG\",\"9001\"]]," +
	"AXIS[\"Easting\",EAST],AXIS[\"Northing\",NORTH],AUTHORITY[\"EPSG\",\"32633\"]]";

var WKT2_UTM = "PROJCRS[\"WGS 84 / UTM zone 33N\",\n  BASEGEOGCRS[\"WGS 84\",DATUM[\"World Geodetic System 1984\",ELLIPSOID[\"WGS 84\",6378137,298.257223563]]],\n" +
	"  CONVERSION[\"UTM zone 33N\",METHOD[\"Transverse Mercator\",ID[\"EPSG\",9807]],PARAMETER[\"Scale factor at natural origin\",0.9996]],\n" +
	"  CS[Cartesian,2],AXIS[\"(E)\",east,ORDER[1],LENGTHUNIT[\"metre\",1]],AXIS[\"(N)\",north,ORDER[2],LENGTHUNIT[\"metre\",1]],\n  ID[\"EPSG\",32633]]";

test("world file: six numbers, corner origin half a cell out from the centre", function () {
	var w = parseWorldFile("0.5\n0\n0\n-0.5\n1000.5\n5000.5\n");
	assert.deepEqual(w, { cellSizeX: 0.5, rotationY: 0, rotationX: 0, cellSizeY: -0.5, centreX: 1000.5, centreY: 5000.5, originX: 1000.25, originY: 5000.75 });
});

test("world file: CRLF, blank lines and spaces are fine; rotation shifts the corner too", function () {
	var w = parseWorldFile("  2\r\n0.5\r\n\r\n0.25\r\n-2\r\n100\r\n200\r\n\r\n");
	assert.equal(w.rotationY, 0.5);
	assert.equal(w.rotationX, 0.25);
	assert.equal(w.originX, 100 - 1 - 0.125);
	assert.equal(w.originY, 200 - 0.25 + 1);
});

test("world file: wrong count or a non-number rejects INVALID_ARGUMENT", function () {
	assert.throws(function () { parseWorldFile("1\n0\n0\n-1\n5\n"); }, { code: "INVALID_ARGUMENT", message: /6 numbers, found 5/ });
	assert.throws(function () { parseWorldFile("1\n0\nx\n-1\n5\n6"); }, { code: "INVALID_ARGUMENT", message: /line 3/ });
	assert.throws(function () { parseWorldFile(42); }, { code: "INVALID_ARGUMENT" });
});

test("prj: ESRI WKT1", function () {
	assert.deepEqual(parsePrj(ESRI_UTM + "\r\n"), {
		wkt: ESRI_UTM, type: "projected", name: "WGS_1984_UTM_Zone_33N", datum: "D_WGS_1984",
		projection: "Transverse_Mercator", units: "Meter", unitFactor: 1, epsg: null
	});
});

test("prj: OGC WKT1 with authorities", function () {
	var c = parsePrj(OGC_UTM);
	assert.equal(c.name, "WGS 84 / UTM zone 33N");
	assert.equal(c.datum, "WGS_1984");
	assert.equal(c.units, "metre");
	assert.equal(c.epsg, 32633);
});

test("prj: WKT2 takes the unit from the axes and the method as projection", function () {
	var c = parsePrj(WKT2_UTM);
	assert.equal(c.type, "projected");
	assert.equal(c.datum, "World Geodetic System 1984");
	assert.equal(c.projection, "Transverse Mercator");
	assert.equal(c.units, "metre");
	assert.equal(c.unitFactor, 1);
	assert.equal(c.epsg, 32633);
});

test("prj: geographic, local, compound and US feet", function () {
	var g = parsePrj("GEOGCS[\"GCS_WGS_1984\",DATUM[\"D_WGS_1984\",SPHEROID[\"WGS_1984\",6378137,298.257223563]],PRIMEM[\"Greenwich\",0],UNIT[\"Degree\",0.0174532925199433]]");
	assert.equal(g.type, "geographic");
	assert.equal(g.projection, null);
	assert.equal(g.units, "Degree");
	var l = parsePrj("LOCAL_CS[\"Mine grid\",LOCAL_DATUM[\"Local\",0],UNIT[\"metre\",1]]");
	assert.equal(l.type, "local");
	assert.equal(l.datum, null);
	assert.equal(l.units, "metre");
	var ft = parsePrj("PROJCS[\"Some State Plane\",GEOGCS[\"g\",DATUM[\"d\",SPHEROID[\"s\",1,2]]],PROJECTION[\"Lambert_Conformal_Conic\"],UNIT[\"Foot_US\",0.3048006096012192]]");
	assert.equal(ft.unitFactor, 0.3048006096012192);
	var cmp = parsePrj("COMPD_CS[\"x + h\"," + OGC_UTM + ",VERT_CS[\"h\",VERT_DATUM[\"v\",2005],UNIT[\"metre\",1]]]");
	assert.equal(cmp.type, "compound");
	assert.equal(cmp.name, "x + h");
	assert.equal(cmp.projection, "Transverse_Mercator");
	assert.equal(cmp.epsg, null);
});

test("prj: quotes, parentheses and escaped quotes", function () {
	var c = parsePrj("PROJCS(\"a \"\"b\"\"\",GEOGCS(\"g\",DATUM(\"d\",SPHEROID(\"s\",1,2))),PROJECTION(\"p\"),UNIT(\"m\",1))");
	assert.equal(c.name, "a \"b\"");
	assert.equal(c.projection, "p");
	assert.equal(c.units, "m");
});

test("prj: malformed text rejects INVALID_ARGUMENT", function () {
	["", "hello", "PROJCS[\"x\"", "PROJCS[\"x\" \"y\"]", "PROJCS[\"x]", "PROJCS[\"x\"] tail", "PROJCS[,]"].forEach(function (bad) {
		assert.throws(function () { parsePrj(bad); }, { code: "INVALID_ARGUMENT", message: /prj is not valid WKT/ }, JSON.stringify(bad));
	});
	assert.throws(function () { parsePrj(null); }, { code: "INVALID_ARGUMENT" });
});

test("pickSidecars matches by name, ignoring case", function () {
	var ecw = { name: "Site.ECW" };
	var files = [ecw, { name: "other.eww" }, { name: "site.eww" }, { name: "SITE.prj" }, { name: "site.wld" }, { name: "site.txt" }];
	var s = pickSidecars(ecw, files);
	assert.equal(s.worldFile, files[2]);
	assert.equal(s.prj, files[3]);
	var dotted = pickSidecars({ name: "a.ecw" }, [{ name: "a.ecw.wld" }, { name: "a.ecw.prj" }]);
	assert.equal(dotted.worldFile.name, "a.ecw.wld");
	assert.equal(dotted.prj.name, "a.ecw.prj");
	assert.deepEqual(pickSidecars({ name: "a.ecw" }, [{ name: "b.prj" }]), { worldFile: null, prj: null });
	assert.deepEqual(pickSidecars({ name: "a.ecw" }), { worldFile: null, prj: null });
});
