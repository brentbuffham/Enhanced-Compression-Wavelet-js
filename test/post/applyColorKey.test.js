// test/post/applyColorKey.test.js
//==========================================================
// Colour keys: a pixel whose every channel sits inside a key's
// colour - below .. colour + above range becomes transparent.
// colorKeysFromOptions turns transparentBelow / transparentAbove /
// transparentColor into keys.
// Run with: node --test test/post/applyColorKey.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyColorKey, colorKeysFromOptions } from "../../src/post/applyColorKey.js";

function px(list) { return Uint8ClampedArray.from(list); }
function alphas(rgba) { var a = []; for (var i = 3; i < rgba.length; i += 4) a.push(rgba[i]); return a; }

test("an exact colour clears only that colour", function () {
	var rgba = px([10, 20, 30, 255, 10, 20, 31, 255, 11, 20, 30, 255]);
	assert.deepEqual(alphas(applyColorKey(rgba, [{ color: [10, 20, 30] }])), [0, 255, 255]);
});

test("below and above set an asymmetric range per channel", function () {
	var key = [{ color: [100, 100, 100], below: 5, above: 2 }];
	var rgba = px([95, 102, 100, 255, 94, 100, 100, 255, 100, 103, 100, 255, 95, 95, 102, 255]);
	assert.deepEqual(alphas(applyColorKey(rgba, key)), [0, 255, 255, 0]);
});

test("ranges past 0 or 255 clamp", function () {
	var rgba = px([0, 0, 0, 255, 255, 255, 255, 255]);
	assert.deepEqual(alphas(applyColorKey(rgba, [{ color: [2, 2, 2], below: 9 }, { color: [250, 250, 250], above: 9 }])), [0, 0]);
});

test("a pixel matching any key in the list clears", function () {
	var rgba = px([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]);
	assert.deepEqual(alphas(applyColorKey(rgba, [{ color: [1, 2, 3] }, { color: [7, 8, 9] }])), [0, 255, 0]);
});

test("hex colours, either case", function () {
	var rgba = px([0x65, 0x64, 0xab, 255]);
	assert.deepEqual(alphas(applyColorKey(rgba, [{ color: "#6564AB" }])), [0]);
	assert.deepEqual(alphas(applyColorKey(px([0x65, 0x64, 0xab, 255]), [{ color: "#6564ab" }])), [0]);
});

test("kept pixels keep their alpha and RGB is untouched", function () {
	var rgba = px([9, 9, 9, 128, 1, 1, 1, 255]);
	applyColorKey(rgba, [{ color: [1, 1, 1] }]);
	assert.deepEqual(Array.from(rgba), [9, 9, 9, 128, 1, 1, 1, 0]);
});

test("a single key object works like a one-item list", function () {
	assert.deepEqual(alphas(applyColorKey(px([5, 5, 5, 255]), { color: [5, 5, 5] })), [0]);
});

test("returns the same array", function () {
	var rgba = px([0, 0, 0, 255]);
	assert.equal(applyColorKey(rgba, [{ color: [0, 0, 0] }]), rgba);
});

test("bad keys throw INVALID_ARGUMENT", function () {
	[
		null, [], [null], [{}], [{ color: [1, 2] }], [{ color: [1, 2, 256] }], [{ color: [1, 2, 1.5] }],
		[{ color: "#12345" }], [{ color: "123456" }], [{ color: "#12345g" }],
		[{ color: [1, 2, 3], below: -1 }], [{ color: [1, 2, 3], above: 256 }], [{ color: [1, 2, 3], below: "2" }]
	].forEach(function (keys) {
		assert.throws(function () { applyColorKey(px([0, 0, 0, 255]), keys); }, { code: "INVALID_ARGUMENT" }, JSON.stringify(keys));
	});
});

test("no transparency options gives no keys", function () {
	assert.equal(colorKeysFromOptions({}), null);
});

test("transparentBelow N is black with N above", function () {
	assert.deepEqual(colorKeysFromOptions({ transparentBelow: 8 }), [{ color: [0, 0, 0], below: 0, above: 8 }]);
});

test("transparentAbove N is white with 255 - N below", function () {
	assert.deepEqual(colorKeysFromOptions({ transparentAbove: 247 }), [{ color: [255, 255, 255], below: 8, above: 0 }]);
});

test("transparentColor takes one key or a list, normalised", function () {
	assert.deepEqual(colorKeysFromOptions({ transparentColor: { color: "#0a141e", below: 2 } }), [{ color: [10, 20, 30], below: 2, above: 0 }]);
	assert.deepEqual(colorKeysFromOptions({ transparentColor: [{ color: [1, 2, 3] }, { color: [4, 5, 6], above: 1 }] }),
		[{ color: [1, 2, 3], below: 0, above: 0 }, { color: [4, 5, 6], below: 0, above: 1 }]);
});

test("all three options combine", function () {
	var keys = colorKeysFromOptions({ transparentBelow: 3, transparentAbove: 250, transparentColor: { color: [1, 2, 3] } });
	assert.equal(keys.length, 3);
});

test("bad options name the option in the error", function () {
	assert.throws(function () { colorKeysFromOptions({ transparentBelow: 256 }); }, { code: "INVALID_ARGUMENT", message: /transparentBelow/ });
	assert.throws(function () { colorKeysFromOptions({ transparentAbove: -1 }); }, { code: "INVALID_ARGUMENT", message: /transparentAbove/ });
	assert.throws(function () { colorKeysFromOptions({ transparentColor: { color: "red" } }); }, { code: "INVALID_ARGUMENT", message: /transparentColor/ });
});
