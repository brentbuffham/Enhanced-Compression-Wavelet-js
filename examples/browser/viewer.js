// examples/browser/viewer.js
//==========================================================
// Canvas viewer: shows one RGBA "picture" spanning map bounds,
// with wheel zoom, drag pan, hover reporting, a polygon tool and a point picker.
// Block maps are drawn nearest-neighbour so they stay crisp; decoded
// images (picture.smooth) are drawn with high-quality smoothing, or
// pixel for pixel when the view is at scale 1.
// Colour: the canvas works in Display P3 where supported. Pixels are
// tagged sRGB (colour-managed, correct) or, with setVivid(true), Display
// P3, so a wide-gamut screen shows the raw values unconverted, the way
// QGIS and other unmanaged viewers do.
// An optional detail layer (a sharper decode of the visible area)
// is drawn over the picture; onViewChange fires when zoom/pan settle.
//==========================================================

import { screenToMap, mapToScreen } from "./lib/viewMath.js";

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{onHover?: function, onPolygon?: function}} callbacks
 */
export function Viewer(canvas, callbacks) {
	this.canvas = canvas;
	this.ctx = canvas.getContext("2d", { colorSpace: "display-p3" }) || canvas.getContext("2d");
	this.vivid = false;
	this.callbacks = callbacks || {};
	this.picture = null;
	this.bitmap = null;
	this.view = null;
	this.polygon = [];
	this.drawing = false;
	this.picking = null;
	this.detail = null;
	this._bind();
	this._resize();
	new ResizeObserver(this._resize.bind(this)).observe(canvas);
}

Viewer.prototype._resize = function () {
	var dpr = window.devicePixelRatio || 1;
	this.canvas.width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
	this.canvas.height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
	this.dpr = dpr;
	if (this.picture && !this._userMoved) this.fit();
	this.draw();
};

/**
 * Show a picture.
 * @param {{rgba: Uint8ClampedArray, width: number, height: number, bounds: object, smooth?: boolean}} picture
 * @param {boolean} [keepView] - keep zoom/pan when the picture size is unchanged
 */
// An offscreen canvas holding rgba, tagged sRGB or (vivid) Display P3
Viewer.prototype._bitmap = function (rgba, width, height) {
	var space = this.vivid ? "display-p3" : "srgb";
	var off = document.createElement("canvas");
	off.width = width;
	off.height = height;
	var ctx = off.getContext("2d", { colorSpace: space }) || off.getContext("2d");
	var image;
	try {
		image = new ImageData(rgba, width, height, { colorSpace: space });
	} catch (err) {
		image = new ImageData(rgba, width, height);
	}
	ctx.putImageData(image, 0, 0);
	return off;
};

/**
 * Show raw pixel values on wide-gamut screens (like unmanaged viewers) or colour-manage them.
 * @param {boolean} vivid
 */
Viewer.prototype.setVivid = function (vivid) {
	this.vivid = !!vivid;
	if (this.picture) this.bitmap = this._bitmap(this.picture.rgba, this.picture.width, this.picture.height);
	if (this.detail) this.detail.bitmap = this._bitmap(this.detail.rgba, this.detail.width, this.detail.height);
	this.draw();
};

Viewer.prototype.setPicture = function (picture, keepView) {
	var sameSize = this.picture && this.picture.width === picture.width && this.picture.height === picture.height;
	this.picture = picture;
	this.detail = null;
	this.bitmap = this._bitmap(picture.rgba, picture.width, picture.height);
	if (!(keepView && sameSize)) {
		this._userMoved = false;
		this.fit();
	} else {
		this.view.bounds = picture.bounds;
	}
	this.draw();
};

Viewer.prototype.fit = function () {
	var p = this.picture;
	var scale = Math.min(this.canvas.width / p.width, this.canvas.height / p.height) * 0.95;
	// a picture made for this canvas fits at scale 1: draw it pixel for pixel
	if (Math.abs(scale - 1) < 0.02) scale = 1;
	this.view = {
		bounds: p.bounds, width: p.width, height: p.height, scale: scale,
		offsetX: Math.round((this.canvas.width - p.width * scale) / 2),
		offsetY: Math.round((this.canvas.height - p.height * scale) / 2)
	};
};

/**
 * Draw a sharper image of part of the map over the picture.
 * @param {{rgba: Uint8ClampedArray, width: number, height: number, bounds: object}} detail
 */
Viewer.prototype.setDetail = function (detail) {
	this.detail = { bitmap: this._bitmap(detail.rgba, detail.width, detail.height), rgba: detail.rgba, width: detail.width, height: detail.height, bounds: detail.bounds };
	this.draw();
};

Viewer.prototype.clearDetail = function () {
	this.detail = null;
	this.draw();
};

/**
 * Map bounds currently on screen and the canvas size in device pixels.
 * @returns {{bounds: {minX, minY, maxX, maxY}, width: number, height: number}|null}
 */
Viewer.prototype.visible = function () {
	if (!this.view) return null;
	var a = screenToMap(this.view, 0, 0);
	var b = screenToMap(this.view, this.canvas.width, this.canvas.height);
	return { bounds: { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) }, width: this.canvas.width, height: this.canvas.height };
};

Viewer.prototype._viewChanged = function () {
	var self = this;
	clearTimeout(this._viewTimer);
	this._viewTimer = setTimeout(function () { if (self.callbacks.onViewChange) self.callbacks.onViewChange(); }, 250);
};

Viewer.prototype.draw = function () {
	var ctx = this.ctx;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
	if (!this.bitmap || !this.view) return;
	var v = this.view;
	ctx.imageSmoothingEnabled = !!this.picture.smooth && v.scale !== 1;
	ctx.imageSmoothingQuality = "high";
	if (v.scale === 1) ctx.drawImage(this.bitmap, Math.round(v.offsetX), Math.round(v.offsetY));
	else ctx.drawImage(this.bitmap, v.offsetX, v.offsetY, v.width * v.scale, v.height * v.scale);
	if (this.detail) {
		var tl = mapToScreen(v, this.detail.bounds.minX, this.detail.bounds.maxY);
		var br = mapToScreen(v, this.detail.bounds.maxX, this.detail.bounds.minY);
		ctx.imageSmoothingEnabled = true;
		ctx.drawImage(this.detail.bitmap, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
		ctx.imageSmoothingEnabled = false;
	}
	this._drawPolygon();
};

Viewer.prototype._drawPolygon = function () {
	if (!this.polygon.length) return;
	var ctx = this.ctx;
	var view = this.view;
	ctx.save();
	ctx.lineWidth = 2 * this.dpr;
	ctx.strokeStyle = "#ff3b6b";
	ctx.fillStyle = "rgba(255, 59, 107, 0.15)";
	ctx.beginPath();
	this.polygon.forEach(function (pt, i) {
		var s = mapToScreen(view, pt[0], pt[1]);
		if (i === 0) ctx.moveTo(s.x, s.y);
		else ctx.lineTo(s.x, s.y);
	});
	if (!this.drawing) ctx.closePath();
	ctx.fill();
	ctx.stroke();
	this.polygon.forEach(function (pt) {
		var s = mapToScreen(view, pt[0], pt[1]);
		ctx.fillStyle = "#ff3b6b";
		ctx.fillRect(s.x - 3 * this.dpr, s.y - 3 * this.dpr, 6 * this.dpr, 6 * this.dpr);
	}, this);
	ctx.restore();
};

Viewer.prototype.startPolygon = function () {
	this.polygon = [];
	this.drawing = true;
	this.canvas.classList.add("drawing");
	this.draw();
};

Viewer.prototype.clearPolygon = function () {
	this.polygon = [];
	this.drawing = false;
	this.canvas.classList.remove("drawing");
	this.draw();
};

/**
 * Wait for one click on the map and pass its map coordinates to onPick.
 * @param {function({x:number, y:number})} onPick
 */
Viewer.prototype.startPick = function (onPick) {
	this.picking = onPick;
	this.canvas.classList.add("drawing");
};

Viewer.prototype._eventPoint = function (event) {
	var rect = this.canvas.getBoundingClientRect();
	return { x: (event.clientX - rect.left) * this.dpr, y: (event.clientY - rect.top) * this.dpr };
};

Viewer.prototype._bind = function () {
	var self = this;
	var drag = null;
	this.canvas.addEventListener("wheel", function (event) {
		if (!self.view) return;
		event.preventDefault();
		var p = self._eventPoint(event);
		var factor = Math.exp(-event.deltaY * 0.0015);
		var v = self.view;
		v.offsetX = p.x - (p.x - v.offsetX) * factor;
		v.offsetY = p.y - (p.y - v.offsetY) * factor;
		v.scale *= factor;
		self._userMoved = true;
		self.draw();
		self._viewChanged();
	}, { passive: false });
	this.canvas.addEventListener("pointerdown", function (event) {
		if (!self.view || self.drawing || self.picking) return;
		drag = { start: self._eventPoint(event), offsetX: self.view.offsetX, offsetY: self.view.offsetY };
		self.canvas.setPointerCapture(event.pointerId);
		self.canvas.classList.add("panning");
	});
	this.canvas.addEventListener("pointermove", function (event) {
		if (!self.view) return;
		var p = self._eventPoint(event);
		if (drag) {
			self.view.offsetX = drag.offsetX + p.x - drag.start.x;
			self.view.offsetY = drag.offsetY + p.y - drag.start.y;
			self._userMoved = true;
			self.draw();
			return;
		}
		if (self.callbacks.onHover) {
			var v = self.view;
			var px = Math.floor((p.x - v.offsetX) / v.scale);
			var py = Math.floor((p.y - v.offsetY) / v.scale);
			var inside = px >= 0 && py >= 0 && px < v.width && py < v.height;
			self.callbacks.onHover(inside ? { px: px, py: py, map: screenToMap(v, p.x, p.y) } : null);
		}
	});
	this.canvas.addEventListener("pointerup", function () {
		if (drag) self._viewChanged();
		drag = null;
		self.canvas.classList.remove("panning");
	});
	this.canvas.addEventListener("pointerleave", function () {
		if (self.callbacks.onHover) self.callbacks.onHover(null);
	});
	this.canvas.addEventListener("click", function (event) {
		if (self.picking && self.view) {
			var onPick = self.picking;
			self.picking = null;
			if (!self.drawing) self.canvas.classList.remove("drawing");
			var at = self._eventPoint(event);
			onPick(screenToMap(self.view, at.x, at.y));
			return;
		}
		if (!self.drawing || !self.view) return;
		var p = self._eventPoint(event);
		var m = screenToMap(self.view, p.x, p.y);
		self.polygon.push([m.x, m.y]);
		self.draw();
	});
	this.canvas.addEventListener("dblclick", function () {
		if (!self.drawing) return;
		// The double-click's second click added a duplicate point
		self.polygon.pop();
		self.drawing = false;
		self.canvas.classList.remove("drawing");
		self.draw();
		if (self.callbacks.onPolygon) self.callbacks.onPolygon(self.polygon.slice());
	});
};
