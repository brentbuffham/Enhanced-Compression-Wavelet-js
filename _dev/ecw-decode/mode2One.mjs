// _dev/ecw-decode/mode2One.mjs
// Decode one mode-2 payload (hex) LSB-first, left = 0, printing symbols and totals.
// Usage: node _dev/ecw-decode/mode2One.mjs <hex> <count>
import { readTree } from "./mode2Decode.mjs";
var b = Uint8Array.from(process.argv[2].replace(/\s+/g, "").match(/../g).map(function (h) { return parseInt(h, 16); }));
var count = Number(process.argv[3]);
var t = readTree(b, { 4: "+", 5: "z", 6: "-" });
function name(l) { return l.run ? "z" + l.run : (l.value > 0 ? "+" : "") + l.value; }
function codes(n, prefix, out) { if (n.leaf) out.push(prefix + "=" + name(n.leaf)); else { codes(n.left, prefix + "0", out); codes(n.right, prefix + "1", out); } return out; }
console.log("codes", codes(t.root, "", []).join(" "));
var pos = t.dataStart * 8, end = b.length * 8, out = [], total = 0;
while (pos < end && total < count) { var n = t.root; while (!n.leaf && pos < end) { var bit = (b[pos >> 3] >> (pos & 7)) & 1; pos++; n = bit === 0 ? n.left : n.right; } if (!n.leaf) break; out.push(name(n.leaf)); total += n.leaf.run || 1; }
console.log("total", total, "of", count, "bits used", pos - t.dataStart * 8, "of", end - t.dataStart * 8);
console.log(out.join(" "));
