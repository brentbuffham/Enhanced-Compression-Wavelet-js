// examples/browser/lib/viewMath.js
//==========================================================
// Screen <-> map transforms for the demo viewer. The picture has
// `width` x `height` pixels spanning `bounds` (row 0 = maxY) and
// is drawn at `scale` with its top-left at (offsetX, offsetY).
//==========================================================

/**
 * @param {{bounds:object, width:number, height:number, scale:number, offsetX:number, offsetY:number}} view
 * @returns {{x:number, y:number}} map coordinates
 */
export function screenToMap(view, sx, sy) {
	var px = (sx - view.offsetX) / view.scale;
	var py = (sy - view.offsetY) / view.scale;
	var b = view.bounds;
	return {
		x: b.minX + px / view.width * (b.maxX - b.minX),
		y: b.maxY - py / view.height * (b.maxY - b.minY)
	};
}

/**
 * @returns {{x:number, y:number}} screen coordinates
 */
export function mapToScreen(view, x, y) {
	var b = view.bounds;
	var px = (x - b.minX) / (b.maxX - b.minX) * view.width;
	var py = (b.maxY - y) / (b.maxY - b.minY) * view.height;
	return { x: view.offsetX + px * view.scale, y: view.offsetY + py * view.scale };
}
