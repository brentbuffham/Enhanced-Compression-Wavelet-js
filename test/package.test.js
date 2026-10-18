// test/package.test.js
//==========================================================
// Package shape: zero-dependency ES module with the npm fields
// the spec pins (spec §11). Run with: node --test test/package.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

var pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("package is a zero-dependency ES module", function () {
	assert.equal(pkg.name, "ecw-js");
	assert.equal(pkg.type, "module");
	assert.equal(pkg.license, "MIT");
	assert.equal(pkg.sideEffects, false);
	assert.deepEqual(pkg.engines, { node: ">=22" });
	assert.equal(pkg.dependencies, undefined);
	assert.equal(pkg.devDependencies, undefined);
	assert.deepEqual(pkg.files, ["src", "README.md", "LICENSE", "CHANGELOG.md"]);
	assert.equal(pkg.exports["."], "./src/index.js");
});

test("VERSION export matches package.json", async function () {
	var mod = await import("../src/index.js");
	assert.equal(mod.VERSION, pkg.version);
});
