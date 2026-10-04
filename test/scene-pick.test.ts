// @vitest-environment happy-dom
/**
 * Hit-testing tests.
 *
 * `pick` decides what the tooltip claims you are pointing at, so getting it
 * wrong is invisible in a screenshot but very visible to a user: the tooltip
 * described markers that were hidden underneath other markers, and small loot
 * squares activated from three times their own radius away.
 *
 * Canvas is stubbed because happy-dom has no 2D context; `pick` never touches it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from '../src/render/scene';
import type { SceneInput } from '../src/render/scene';
import { HeatmapLayer } from '../src/render/heatmap';
import { EVENT_TYPES } from '../src/core/types';
import type { Journey, MapId } from '../src/core/types';
import { MAPS } from '../src/core/maps';

/** 1000x1000 canvas showing a square map, so UV maps 1:1 to 1000 CSS pixels. */
const CANVAS = 1000;
const MAP: MapId = 'AmbroseValley';

const E_POSITION = EVENT_TYPES.indexOf('Position');
const E_LOOT = EVENT_TYPES.indexOf('Loot');
const E_KILL = EVENT_TYPES.indexOf('Kill');
const E_DEATH = EVENT_TYPES.indexOf('Killed');
const E_STORM = EVENT_TYPES.indexOf('KilledByStorm');

function blankInput(journeys: Journey[], overrides: Partial<SceneInput> = {}): SceneInput {
  return {
    mapId: MAP,
    journeys,
    showHumans: true,
    showBots: true,
    showKills: true,
    showDeaths: true,
    showLoot: true,
    showStormDeaths: true,
    heatmap: new HeatmapLayer(),
    heatmapAlpha: 0,
    showPathsWithHeatmap: true,
    cursor: null,
    
    ...overrides,
  };
}

/** Builds a one-sample journey at the given UV, with the given event type. */
function at(u: number, v: number, event: number, userId = 'a'): Journey {
  const { originX, originZ, scale } = MAPS[MAP];
  return {
    userId,
    matchId: 'm',
    mapId: MAP,
    day: 'February_10',
    source: 'test',
    isBot: false,
    t0: 0,
    t1: 0,
    x: Float32Array.from([originX + u * scale]),
    y: Float32Array.from([0]),
    z: Float32Array.from([originZ + v * scale]),
    t: Float64Array.from([0]),
    e: Uint8Array.from([event]),
  } as unknown as Journey;
}

/** World coords of the UV point, for building hover positions. */
function world(u: number, v: number): { x: number; z: number } {
  const { originX, originZ, scale } = MAPS[MAP];
  return { x: originX + u * scale, z: originZ + v * scale };
}

let scene: Scene;

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    setTransform: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    stroke: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: () => undefined,
  })) as never;

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: CANVAS,
    height: CANVAS,
    top: 0,
    left: 0,
    right: CANVAS,
    bottom: CANVAS,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);

  scene = new Scene(document.createElement('canvas'));
  scene.resize(MAP);
});

describe('pick: paint order', () => {
  it('returns the topmost marker when two kinds share a spot', () => {
    // Loot is painted first, storm death last, both at the exact same UV.
    const input = blankInput([
      at(0.5, 0.5, E_LOOT, 'looter'),
      at(0.5, 0.5, E_STORM, 'stormy'),
    ]);

    const target = scene.pick(input, CANVAS * 0.5, CANVAS * 0.5);
    expect(target?.kind).toBe('stormDeath');
  });

  it('prefers a death over a kill over loot at the same spot', () => {
    const target = scene.pick(
      blankInput([at(0.5, 0.5, E_KILL), at(0.5, 0.5, E_DEATH), at(0.5, 0.5, E_LOOT)]),
      CANVAS * 0.5,
      CANVAS * 0.5,
    );
    expect(target?.kind).toBe('death');
  });

  it('lets a rare marker win even when a denser one is nearer the cursor', () => {
    // The loot square sits exactly under the cursor; the storm death is 5px away,
    // which is inside its own (larger) radius, and it is painted on top.
    const target = scene.pick(
      blankInput([at(0.5, 0.505, E_LOOT, 'looter'), at(0.5, 0.5, E_STORM, 'stormy')]),
      CANVAS * 0.5,
      CANVAS * (1 - 0.505),
    );

    expect(target?.kind).toBe('stormDeath');
    expect(target?.journey.userId).toBe('stormy');
  });

  it('prefers the later journey when two identical markers coincide', () => {
    // Same kind, same spot: paint order means the last journey is on top.
    const target = scene.pick(
      blankInput([at(0.5, 0.5, E_LOOT, 'first'), at(0.5, 0.5, E_LOOT, 'second')]),
      CANVAS * 0.5,
      CANVAS * 0.5,
    );
    expect(target?.journey.userId).toBe('second');
  });

  it('picks the nearest sample within the winning kind', () => {
    // Same kind twice, 2px and 40px away. The nearer one should win because
    // distance is the tiebreak inside a kind.
    const near = at(0.5, 0.5, E_LOOT, 'near');
    const far = at(0.5, 0.44, E_LOOT, 'far');
    const target = scene.pick(blankInput([far, near]), CANVAS * 0.5, CANVAS * 0.5);
    expect(target?.journey.userId).toBe('near');
  });
});

describe('pick: hit radius', () => {
  it('does not hit a loot square from far outside its drawn size', () => {
    // Loot is drawn at 3.5px, so its hit radius is 6.5px. 9px must miss.
    const target = scene.pick(
      blankInput([at(0.5, 0.5, E_LOOT)]),
      CANVAS * 0.5,
      CANVAS * (1 - 0.5) + 9,
    );
    expect(target).toBeNull();
  });

  it('still hits a loot square within its radius', () => {
    const target = scene.pick(
      blankInput([at(0.5, 0.5, E_LOOT)]),
      CANVAS * 0.5,
      CANVAS * 0.5 + 5,
    );
    expect(target?.kind).toBe('loot');
  });

  it('scales every radius together for click selection', () => {
    const input = blankInput([at(0.5, 0.5, E_LOOT)]);
    const y = CANVAS * 0.5 + 9;
    // Hover misses at 9px...
    expect(scene.pick(input, CANVAS * 0.5, y)).toBeNull();
    // ...but a click, scaled 1.4x, reaches 9.1px and connects.
    expect(scene.pick(input, CANVAS * 0.5, y, 1.4)).not.toBeNull();
  });

  it('gives every kind a radius derived from what is drawn', () => {
    const cases: Array<[string, number]> = [
      ['Loot', E_LOOT],
      ['Kill', E_KILL],
      ['Killed', E_DEATH],
      ['KilledByStorm', E_STORM],
    ];

    for (const [event, code] of cases) {
      const exact = scene.pick(blankInput([at(0.5, 0.5, code)]), CANVAS * 0.5, CANVAS * 0.5);
      expect(exact, `${event} should be hittable at its centre`).not.toBeNull();

      // Well outside any plausible marker radius: nothing should be found.
      const far = scene.pick(blankInput([at(0.5, 0.5, code)]), CANVAS * 0.5, CANVAS * 0.5 + 40);
      expect(far, `${event} should not be hittable from 40px away`).toBeNull();
    }
  });
});

describe('pick: filters and modes', () => {
  it('ignores markers whose toggle is off', () => {
    const input = blankInput([at(0.5, 0.5, E_LOOT)], { showLoot: false });
    expect(scene.pick(input, CANVAS * 0.5, CANVAS * 0.5)).toBeNull();
  });

  it('finds a death even when loot is hidden and they coincide', () => {
    const input = blankInput([at(0.5, 0.5, E_LOOT, 'looter'), at(0.5, 0.5, E_DEATH, 'dead')], {
      showLoot: false,
    });
    const target = scene.pick(input, CANVAS * 0.5, CANVAS * 0.5);
    expect(target?.kind).toBe('death');
  });

  it('skips hidden subjects', () => {
    const input = blankInput([at(0.5, 0.5, E_LOOT)], { showHumans: false });
    expect(scene.pick(input, CANVAS * 0.5, CANVAS * 0.5)).toBeNull();
  });

  it('will not pick a movement sample during playback', () => {
    // During playback only a prefix of the journey is drawn, so hover targets
    // must come from markers rather than from the whole path.
    const input = blankInput([at(0.5, 0.5, E_POSITION)], { cursor: 0 });
    expect(scene.pick(input, CANVAS * 0.5, CANVAS * 0.5)).toBeNull();
  });

  it('does pick a movement sample in the static view', () => {
    const input = blankInput([at(0.5, 0.5, E_POSITION)]);
    const target = scene.pick(input, CANVAS * 0.5, CANVAS * 0.5);
    expect(target?.kind).toBe('position');
  });

  it('reports world coordinates and time for the hit', () => {
    const target = scene.pick(blankInput([at(0.25, 0.75, E_KILL)]), CANVAS * 0.25, CANVAS * 0.25);
    const { x, z } = world(0.25, 0.75);
    expect(target?.worldX).toBeCloseTo(x, 3);
    expect(target?.worldZ).toBeCloseTo(z, 3);
    expect(target?.t).toBe(0);
  });
});