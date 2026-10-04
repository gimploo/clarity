/**
 * Viewport tests.
 *
 * The viewport owns the UV -> pixel transform used by both drawing and hit
 * testing, so a bug here shows up as markers that cannot be clicked or as paths
 * that drift under zoom. It touches no DOM, so it tests directly.
 */
import { describe, expect, it } from 'vitest';
import { Viewport } from '../src/render/viewport';

/** Guards against float drift through the zoom/pan arithmetic. */
const close = (a: number, b: number, tolerance = 1e-6): void => {
  expect(Math.abs(a - b)).toBeLessThan(tolerance);
};

function squareMap(size = 400): Viewport {
  const viewport = new Viewport();
  viewport.resize(size, size, 1);
  return viewport;
}

describe('fitRect', () => {
  it('fills the canvas when the canvas and map share an aspect', () => {
    const rect = squareMap().fitRect();
    expect(rect).toEqual({ x: 0, y: 0, w: 400, h: 400 });
  });

  it('letterboxes a tall map instead of distorting it', () => {
    const viewport = new Viewport();
    viewport.resize(400, 200, 1);
    const rect = viewport.fitRect();
    // Height is the constraint, so width shrinks and centres horizontally.
    expect(rect.h).toBe(200);
    expect(rect.w).toBe(200);
    close(rect.x, 100);
  });

  it('handles the near-square Grand Rift aspect without stretching', () => {
    const viewport = new Viewport();
    // Grand Rift's minimap is 2160x2158, so marginally wider than tall.
    const aspect = 2160 / 2158;
    viewport.resize(1000, 1000, aspect);

    const rect = viewport.fitRect();
    // Width is the limiting dimension, so the map is full-width and letterboxed.
    expect(rect.w).toBe(1000);
    close(rect.h, 1000 / aspect);
    // ...and it stays centred in the leftover vertical space.
    close(rect.y + rect.h / 2, 500);
    close(rect.x, 0);
  });
});

describe('project / unproject', () => {
  it('places UV (0,0) at the top-left of the map rect', () => {
    const viewport = squareMap();
    const point = viewport.project(0, 0);
    // V is flipped, so UV v=0 is the *bottom* of the image.
    expect(point.x).toBe(0);
    expect(point.y).toBe(400);
  });

  it('places UV (1,1) at the bottom-right', () => {
    const point = squareMap().project(1, 1);
    expect(point.x).toBe(400);
    expect(point.y).toBe(0);
  });

  it('round-trips at zoom 1', () => {
    const viewport = squareMap();
    for (const u of [0, 0.25, 0.5, 1]) {
      for (const v of [0, 0.5, 1]) {
        const point = viewport.project(u, v);
        const back = viewport.unproject(point.x, point.y);
        close(back.u, u);
        close(back.v, v);
      }
    }
  });

  it('round-trips when zoomed and panned', () => {
    const viewport = squareMap();
    viewport.zoomAt(4, 120, 300);
    viewport.panBy(-37, 88);

    const point = viewport.project(0.3, 0.7);
    const back = viewport.unproject(point.x, point.y);
    close(back.u, 0.3, 1e-9);
    close(back.v, 0.7, 1e-9);
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const viewport = squareMap();
    const anchorX = 137;
    const anchorY = 271;
    const before = viewport.unproject(anchorX, anchorY);

    viewport.zoomAt(2.5, anchorX, anchorY);
    const after = viewport.unproject(anchorX, anchorY);

    close(after.u, before.u, 1e-6);
    close(after.v, before.v, 1e-6);
  });
});

describe('zoom clamping', () => {
  it('never zooms out past the fitted map', () => {
    const viewport = squareMap();
    viewport.zoomAt(0.1, 200, 200);
    expect(viewport.zoom).toBe(Viewport.MIN_ZOOM);
  });

  it('never zooms in past the maximum', () => {
    const viewport = squareMap();
    for (let i = 0; i < 40; i++) viewport.zoomAt(2, 200, 200);
    expect(viewport.zoom).toBe(Viewport.MAX_ZOOM);
  });

  it('returns to the fitted view on reset', () => {
    const viewport = squareMap();
    viewport.zoomAt(6, 200, 200);
    viewport.panBy(50, 50);
    viewport.reset();
    expect(viewport.zoom).toBe(1);
    expect(viewport.panX).toBe(0);
    expect(viewport.panY).toBe(0);
  });
});

describe('fitToUv', () => {
  it('zooms in on a small region', () => {
    const viewport = squareMap();
    viewport.fitToUv(0.4, 0.6, 0.4, 0.6);
    expect(viewport.zoom).toBeGreaterThan(1);
  });

  it('stays at fit zoom when asked to frame the whole map', () => {
    const viewport = squareMap();
    viewport.fitToUv(0, 1, 0, 1);
    expect(viewport.zoom).toBe(Viewport.MIN_ZOOM);
  });

  it('centres the requested region', () => {
    const viewport = squareMap();
    viewport.fitToUv(0.45, 0.55, 0.45, 0.55);
    const centre = viewport.project(0.5, 0.5);
    close(centre.x, 200, 1);
    close(centre.y, 200, 1);
  });

  it('does not blow up on a degenerate region', () => {
    const viewport = squareMap();
    viewport.fitToUv(0.5, 0.5, 0.5, 0.5);
    expect(Number.isFinite(viewport.zoom)).toBe(true);
    expect(viewport.zoom).toBeLessThanOrEqual(Viewport.MAX_ZOOM);
  });
});