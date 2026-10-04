/**
 * Maps normalised minimap UV to canvas pixels, letterboxed to fit.
 *
 * Keeping this separate from the drawing code means hit-testing (mouse -> world
 * coordinate) is the exact inverse of rendering, and neither knows about DPR.
 *
 * There is deliberately no zoom or pan (issue #3): the whole minimap is always
 * visible, so `fitRect()` is the only transform and `project`/`unproject` are
 * exact inverses of each other.
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

  resize(width: number, height: number, mapAspect: number): void {
    this.width = width;
    this.height = height;
    this.mapAspect = mapAspect;
  }

  /** The rect the minimap occupies, letterboxed to fit and centred. */
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
    return {
      x: rect.x + u * rect.w,
      y: rect.y + (1 - v) * rect.h,
    };
  }

  /** Canvas pixels -> UV. Inverse of {@link project}. */
  unproject(x: number, y: number): { u: number; v: number } {
    const rect = this.fitRect();
    return {
      u: rect.w === 0 ? 0 : (x - rect.x) / rect.w,
      v: rect.h === 0 ? 0 : 1 - (y - rect.y) / rect.h,
    };
  }

  /** World coordinate -> canvas pixels, via the map's own projection. */
  projectWorld(mapId: { scale: number; originX: number; originZ: number }, x: number, z: number): Point {
    const u = (x - mapId.originX) / mapId.scale;
    const v = (z - mapId.originZ) / mapId.scale;
    return this.project(u, v);
  }
}