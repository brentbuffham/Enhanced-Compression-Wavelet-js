// src/format/georef.js
//==========================================================
// Pixel window -> map-coordinate bounds using the header's
// origin (top-left corner) and cell sizes. Works for north-up
// (negative cellSizeY) and south-up files alike.
//==========================================================

/**
 * @param {{originX:number, originY:number, cellSizeX:number, cellSizeY:number}} info
 * @param {number} x - Left column (full-resolution pixels).
 * @param {number} y - Top row.
 * @param {number} width
 * @param {number} height
 * @returns {{minX:number, minY:number, maxX:number, maxY:number}}
 */
export function pixelWindowToBounds(info, x, y, width, height) {
	var x0 = info.originX + x * info.cellSizeX;
	var x1 = info.originX + (x + width) * info.cellSizeX;
	var y0 = info.originY + y * info.cellSizeY;
	var y1 = info.originY + (y + height) * info.cellSizeY;
	return { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) };
}
