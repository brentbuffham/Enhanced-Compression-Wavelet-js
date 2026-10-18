// examples/browser/viewer.js
//==========================================================
// Canvas viewer: shows one RGBA "picture" spanning map bounds,
// with wheel zoom, drag pan, hover reporting and a polygon tool.
// Pixels are drawn nearest-neighbour so block maps stay crisp.
//==========================================================

import { screenToMap, mapToScreen } from "./lib/viewMath.js";

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{onHover?: function, onPolygon?: function}} callbacks
 */
export function Viewer(canvas, callbacks) {
	this.canvas = canvas;
	this.ctx = canvas.getContext("2d");
	this.callbacks = callbacks || {};
	this.picture = null;
	this.bitmap = null;
	this.view = null;
	this.polygon = [];
	this.drawing = false;
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
 * @param {{rgba: Uint8ClampedArray, width: number, height: number, bounds: object}} picture
 * @param {boolean} [keepView] - keep zoom/pan when the picture size is unchanged
 */
Viewer.prototype.setPicture = function (picture, keepView) {
	var sameSize = this.picture && this.picture.width === picture.width && this.picture.height === picture.height;
	this.picture = picture;
	var off = document.createElement("canvas");
	off.width = picture.width;
	off.height = picture.height;
	off.getContext("2d").putImageData(new ImageData(picture.rgba, picture.width, picture.height), 0, 0);
	this.bitmap = off;
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
	this.view = {
		bounds: p.bounds, width: p.width, height: p.height, scale: scale,
		offsetX: (this.canvas.width - p.width * scale) / 2,
		offsetY: (this.canvas.height - p.height * scale) / 2
	};
};

Viewer.prototype.draw = function () {
	var ctx = this.ctx;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
	if (!this.bitmap || !this.view) return;
	var v = this.view;
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(this.bitmap, v.offsetX, v.offsetY, v.width * v.scale, v.height * v.scale);
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
	}, { passive: false });
	this.canvas.addEventListener("pointerdown", function (event) {
		if (!self.view || self.drawing) return;
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
		drag = null;
		self.canvas.classList.remove("panning");
	});
	this.canvas.addEventListener("pointerleave", function () {
		if (self.callbacks.onHover) self.callbacks.onHover(null);
	});
	this.canvas.addEventListener("click", function (event) {
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
