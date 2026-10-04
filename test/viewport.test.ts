/**
 * Viewport tests.
 *
 * The viewport owns the UV -> pixel transform used by both drawing and hit
 * testing, so a bug here shows up as markers that cannot be clicked or as paths
 * that drift away from the terrain. It touches no DOM, so it tests directly.
 *
 * There is no zoom or pan (issue #3), so the only interesting behaviour is the
 * letterbox fit and the project/unproject pair being exact inverses.
 */
import { describe, expect, it } from 'vitest';
import { Viewport } from '../src/render/viewport';

/** Guards against float drift through the letterbox arithmetic. */
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

  it('letterboxes a wide canvas around a square map', () => {
    const viewport = new Viewport();
    viewport.resize(800, 400, 1);
    const rect = viewport.fitRect();
    // Height is the constraint, so width shrinks and centres horizontally.
    expect(rect.h).toBe(400);
    expect(rect.w).toBe(400);
    close(rect.x, 200);
    close(rect.y, 0);
  });

  it('letterboxes a tall canvas around a square map', () => {
    const viewport = new Viewport();
    viewport.resize(400, 800, 1);
    const rect = viewport.fitRect();
    // Width is the constraint, so height shrinks and centres vertically.
    expect(rect.w).toBe(400);
    expect(rect.h).toBe(400);
    close(rect.x, 0);
    close(rect.y, 200);
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

  it('never exceeds the canvas', () => {
    for (const [w, h, aspect] of [
      [1920, 1080, 1],
      [1080, 1920, 1],
      [640, 480, 2160 / 2158],
    ] as const) {
      const viewport = new Viewport();
      viewport.resize(w, h, aspect);
      const rect = viewport.fitRect();
      expect(rect.w).toBeLessThanOrEqual(w + 1e-9);
      expect(rect.h).toBeLessThanOrEqual(h + 1e-9);
    }
  });
});

describe('project / unproject', () => {
  it('places UV (0,0) at the bottom-left of the map rect', () => {
    const viewport = squareMap();
    const point = viewport.project(0, 0);
    // V is flipped, so UV v=0 is the *bottom* of the image.
    expect(point.x).toBe(0);
    expect(point.y).toBe(400);
  });

  it('places UV (1,1) at the top-right', () => {
    const point = squareMap().project(1, 1);
    expect(point.x).toBe(400);
    expect(point.y).toBe(0);
  });

  it('round-trips across the unit square', () => {
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

  it('round-trips inside a letterboxed rect, not just a full-canvas one', () => {
    // A bug that only appears when the rect is offset from the canvas origin
    // would be invisible in the square case above.
    const viewport = new Viewport();
    viewport.resize(900, 500, 1);

    for (const u of [0, 0.3, 1]) {
      for (const v of [0, 0.7, 1]) {
        const point = viewport.project(u, v);
        const back = viewport.unproject(point.x, point.y);
        close(back.u, u, 1e-9);
        close(back.v, v, 1e-9);
      }
    }
  });

  it('reports UV outside the map for points in the letterbox gutter', () => {
    const viewport = new Viewport();
    viewport.resize(800, 400, 1);
    // Map rect is x=200..600, so the left gutter is off-map.
    const left = viewport.unproject(50, 200);
    expect(left.u).toBeLessThan(0);
    const right = viewport.unproject(750, 200);
    expect(right.u).toBeGreaterThan(1);
  });

  it('survives a zero-sized canvas without dividing by zero', () => {
    const viewport = new Viewport();
    viewport.resize(0, 0, 1);
    const back = viewport.unproject(10, 10);
    expect(Number.isFinite(back.u)).toBe(true);
    expect(Number.isFinite(back.v)).toBe(true);
  });
});

describe('projectWorld', () => {
  it('agrees with projecting the equivalent UV by hand', () => {
    const viewport = squareMap();
    const map = { scale: 900, originX: -370, originZ: -473 };
    const x = 500;
    const z = 120;

    const direct = viewport.projectWorld(map, x, z);
    const manual = viewport.project((x - map.originX) / map.scale, (z - map.originZ) / map.scale);

    close(direct.x, manual.x, 1e-9);
    close(direct.y, manual.y, 1e-9);
  });

  it('is invertible back to world coordinates', () => {
    const viewport = squareMap();
    const map = { scale: 1000, originX: -500, originZ: -500 };
    // Both inside the map: u = 0.375, v = 0.8.
    const x = -125;
    const z = 300;

    const point = viewport.projectWorld(map, x, z);
    const uv = viewport.unproject(point.x, point.y);
    // unproject already returns the unflipped v, matching (z - originZ) / scale.
    close(uv.u * map.scale + map.originX, x, 1e-6);
    close(uv.v * map.scale + map.originZ, z, 1e-6);
  });
});