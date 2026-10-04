/**
 * Maps normalised minimap UV to canvas pixels, with fit, zoom and pan.
 *
 * Keeping this separate from the drawing code means hit-testing (mouse -> world
 * coordinate) is the exact inverse of rendering, and neither knows about DPR.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export class Viewport {
  /** Canvas size in CSS pixels. */
  width = 0;
  height = 0;
  /** width / height of the minimap image. */
  mapAspect = 1;
  zoom = 1;
  /** Pan in CSS pixels. */
  panX = 0;
  panY = 0;

  static readonly MIN_ZOOM = 1;
  static readonly MAX_ZOOM = 24;

  resize(width: number, height: number, mapAspect: number): void {
    this.width = width;
    this.height = height;
    this.mapAspect = mapAspect;
  }

  /** The rect the minimap occupies at zoom 1 with no pan, letterboxed to fit. */
  fitRect(): Rect {
    const canvasAspect = this.width / this.height;
    let w: number;
    let h: number;
    if (canvasAspect > this.mapAspect) {
      h = this.height;
      w = h * this.mapAspect;
    } else {
      w = this.width;
      h = w / this.mapAspect;
    }
    return { x: (this.width - w) / 2, y: (this.height - h) / 2, w, h };
  }

  /** UV -> canvas pixels. V is flipped so world north is up. */
  project(u: number, v: number): Point {
    const rect = this.fitRect();
    const baseX = rect.x + u * rect.w;
    const baseY = rect.y + (1 - v) * rect.h;

    const cx = this.width / 2;
    const cy = this.height / 2;
    return {
      x: cx + (baseX - cx) * this.zoom + this.panX,
      y: cy + (baseY - cy) * this.zoom + this.panY,
    };
  }

  /** Canvas pixels -> UV. Inverse of {@link project}. */
  unproject(x: number, y: number): { u: number; v: number } {
    const rect = this.fitRect();
    const cx = this.width / 2;
    const cy = this.height / 2;

    const baseX = (x - cx - this.panX) / this.zoom + cx;
    const baseY = (y - cy - this.panY) / this.zoom + cy;

    return {
      u: rect.w === 0 ? 0 : (baseX - rect.x) / rect.w,
      v: rect.h === 0 ? 0 : 1 - (baseY - rect.y) / rect.h,
    };
  }

  /** World coordinate -> canvas pixels, via the map's own projection. */
  projectWorld(mapId: { scale: number; originX: number; originZ: number }, x: number, z: number): Point {
    const u = (x - mapId.originX) / mapId.scale;
    const v = (z - mapId.originZ) / mapId.scale;
    return this.project(u, v);
  }

  zoomAt(factor: number, anchorX: number, anchorY: number): void {
    const next = clamp(this.zoom * factor, Viewport.MIN_ZOOM, Viewport.MAX_ZOOM);
    if (next === this.zoom) return;

    // Keep the point under the cursor fixed while zooming.
    const before = this.unproject(anchorX, anchorY);
    this.zoom = next;
    const after = this.unproject(anchorX, anchorY);
    const rect = this.fitRect();
    this.panX += (after.u - before.u) * rect.w * this.zoom;
    this.panY -= (after.v - before.v) * rect.h * this.zoom;
  }

  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
  }

  reset(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  /**
   * Frames a UV bounding box, e.g. to zoom to where the data actually is.
   * Falls back to the full map when the box is degenerate or off-image.
   */
  fitToUv(minU: number, maxU: number, minV: number, maxV: number, padding = 0.08): void {
    const rect = this.fitRect();
    const spanU = Math.max(maxU - minU, 1e-4);
    const spanV = Math.max(maxV - minV, 1e-4);
    const zoom = clamp(
      Math.min(rect.w / (spanU * rect.w * (1 + padding * 2)), rect.h / (spanV * rect.h * (1 + padding * 2))),
      Viewport.MIN_ZOOM,
      Viewport.MAX_ZOOM,
    );

    this.zoom = zoom;
    const centre = this.project((minU + maxU) / 2, (minV + maxV) / 2);
    this.panX = this.width / 2 - centre.x;
    this.panY = this.height / 2 - centre.y;
  }
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}