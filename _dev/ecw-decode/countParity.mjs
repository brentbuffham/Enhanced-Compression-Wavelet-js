// _dev/ecw-decode/countParity.mjs
// Counts pixels differing from every GDAL reference of the private sample (level-0 skipped).
import fs from "node:fs";
import { openEcw } from "../../src/EcwReader.js";
import { readTiff } from "../../test/helpers/readTiff.js";
import { findSample } from "../../test/helpers/samples.js";
var s = findSample(), ecw = await openEcw(await fs.openAsBlob(s.ecwPath));
var man = JSON.parse(fs.readFileSync(s.refDir + "/manifest.json", "utf8")).filter(function (m) { return m.name !== "level-0.tif"; });
var allBad = 0, allTot = 0, parts = [];
for (var m of man) {
	var ref = readTiff(new Uint8Array(fs.readFileSync(s.refDir + "/" + m.name)));
	var img = await ecw.readRegion({ x: m.srcwin[0], y: m.srcwin[1], width: m.srcwin[2], height: m.srcwin[3], outWidth: m.outsize[0], outHeight: m.outsize[1] });
	var bad = 0;
	for (var i = 0; i < ref.width * ref.height; i++) { for (var c = 0; c < 3; c++) if (img.data[i * 4 + c] !== ref.data[i * 3 + c]) { bad++; break; } }
	allBad += bad; allTot += ref.width * ref.height; parts.push(m.name.replace(".tif", "") + ":" + bad);
}
console.log(parts.join(" "), "| total", allBad, "of", allTot);
