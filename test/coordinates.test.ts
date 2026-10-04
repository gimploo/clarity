import { describe, expect, it } from 'vitest';
import { isInsideMap, uvToPixel, uvToWorld, worldBounds, worldToPixel, worldToUv } from '../src/core/coordinates';
import { MAPS } from '../src/core/maps';
import { classifyUserId, matchIdFromFilename, userIdFromFilename } from '../src/core/classify';
import { EVENT_TYPES, isFatal, isMovement, markerKindFor } from '../src/core/types';

describe('world -> UV', () => {
  it('reproduces the worked example in the data README', () => {
    // res/player_data/README.md, AmbroseValley, scale=900, origin=(-370, -473)
    const { u, v } = worldToUv('AmbroseValley', -301.45, -355.55);
    expect(u).toBeCloseTo(0.0762, 4);
    expect(v).toBeCloseTo(0.1305, 4);
  });

  it('places the UV origin at the map origin corner', () => {
    for (const config of Object.values(MAPS)) {
      const { u, v } = worldToUv(config.id, config.originX, config.originZ);
      expect(u).toBeCloseTo(0, 10);
      expect(v).toBeCloseTo(0, 10);
    }
  });

  it('places the far corner of the world span at UV (1,1)', () => {
    for (const config of Object.values(MAPS)) {
      const { u, v } = worldToUv(config.id, config.originX + config.scale, config.originZ + config.scale);
      expect(u).toBeCloseTo(1, 10);
      expect(v).toBeCloseTo(1, 10);
    }
  });

  it('round-trips through uvToWorld', () => {
    for (const config of Object.values(MAPS)) {
      const { u, v } = worldToUv(config.id, 12.5, -300.25);
      const world = uvToWorld(config.id, u, v);
      expect(world.x).toBeCloseTo(12.5, 3);
      expect(world.z).toBeCloseTo(-300.25, 3);
    }
  });

  it('reports the documented world bounds', () => {
    expect(worldBounds('AmbroseValley')).toEqual({ minX: -370, maxX: 530, minZ: -473, maxZ: 427 });
    expect(worldBounds('GrandRift')).toEqual({ minX: -290, maxX: 291, minZ: -290, maxZ: 291 });
    expect(worldBounds('Lockdown')).toEqual({ minX: -500, maxX: 500, minZ: -500, maxZ: 500 });
  });
});

describe('UV -> pixel', () => {
  it('flips the V axis so north is up', () => {
    // v = 0 is the south edge of the map, which is the bottom of the image.
    const bottom = worldToPixel('AmbroseValley', 0, -473, 1024, 1024);
    expect(bottom.px).toBeCloseTo(370 / 900 * 1024, 6);
    expect(bottom.py).toBeCloseTo(1024, 6);

    const top = worldToPixel('AmbroseValley', 0, 427, 1024, 1024);
    expect(top.py).toBeCloseTo(0, 6);
  });

  it('scales to the destination rectangle rather than a hardcoded 1024', () => {
    // This is the bug the README's literal formula introduces. The same world
    // point must land proportionally on any output size.
    const small = worldToPixel('Lockdown', 0, 0, 512, 512);
    const large = worldToPixel('Lockdown', 0, 0, 2048, 2048);
    expect(large.px).toBeCloseTo(small.px * 4, 6);
    expect(large.py).toBeCloseTo(small.py * 4, 6);
    expect(small.px).toBeCloseTo(0.5 * 512, 6);
  });

  it('handles a non-square minimap without distortion', () => {
    // GrandRift's asset is 2048x2046 after downscaling from 2160x2158.
    // Each axis must scale by its own dimension, not by a shared 1024.
    const p = uvToPixel(0.5, 0.5, 2048, 2046);
    expect(p.px).toBeCloseTo(1024, 6);
    expect(p.py).toBeCloseTo(1023, 6);
  });
});

describe('isInsideMap', () => {
  it('accepts unit UV and rejects out-of-range', () => {
    expect(isInsideMap(0, 0)).toBe(true);
    expect(isInsideMap(1, 1)).toBe(true);
    expect(isInsideMap(-0.01, 0.5)).toBe(false);
    expect(isInsideMap(0.5, 1.01)).toBe(false);
    expect(isInsideMap(-0.01, 0.5, 0.05)).toBe(true);
  });
});

describe('user classification', () => {
  it('treats UUIDs as human and integers as bots', () => {
    expect(classifyUserId('f4e072fa-b7af-4761-b567-1d95b7ad0108')).toBe('human');
    expect(classifyUserId('1440')).toBe('bot');
    expect(classifyUserId('382')).toBe('bot');
    expect(classifyUserId('not-an-id')).toBe('unknown');
  });

  it('splits filenames back into user and match ids', () => {
    const name = 'f4e072fa-b7af-4761-b567-1d95b7ad0108_b71aaad8-aa62-4b3a-8534-927d4de18f22.nakama-0';
    expect(userIdFromFilename(name)).toBe('f4e072fa-b7af-4761-b567-1d95b7ad0108');
    expect(matchIdFromFilename(name)).toBe('b71aaad8-aa62-4b3a-8534-927d4de18f22.nakama-0');
  });

  it('handles the bot form', () => {
    const name = '1440_d7e50fad-fb7a-4ed4-932f-e4ca9ff0c97b.nakama-0';
    expect(classifyUserId(userIdFromFilename(name))).toBe('bot');
  });
});

describe('event semantics', () => {
  it('maps each raw event to a display marker', () => {
    expect(markerKindFor(EVENT_TYPES.indexOf('Loot'))).toBe('loot');
    expect(markerKindFor(EVENT_TYPES.indexOf('Kill'))).toBe('kill');
    expect(markerKindFor(EVENT_TYPES.indexOf('BotKill'))).toBe('kill');
    expect(markerKindFor(EVENT_TYPES.indexOf('Killed'))).toBe('death');
    expect(markerKindFor(EVENT_TYPES.indexOf('BotKilled'))).toBe('death');
    expect(markerKindFor(EVENT_TYPES.indexOf('KilledByStorm'))).toBe('stormDeath');
  });

  it('treats position samples as non-markers', () => {
    expect(markerKindFor(EVENT_TYPES.indexOf('Position'))).toBeNull();
    expect(markerKindFor(EVENT_TYPES.indexOf('BotPosition'))).toBeNull();
    expect(isMovement(EVENT_TYPES.indexOf('Position'))).toBe(true);
    expect(isMovement(EVENT_TYPES.indexOf('BotPosition'))).toBe(true);
    expect(isMovement(EVENT_TYPES.indexOf('Loot'))).toBe(false);
  });

  it('marks exactly the three lethal events as fatal', () => {
    expect(isFatal(EVENT_TYPES.indexOf('Killed'))).toBe(true);
    expect(isFatal(EVENT_TYPES.indexOf('BotKilled'))).toBe(true);
    expect(isFatal(EVENT_TYPES.indexOf('KilledByStorm'))).toBe(true);
    expect(isFatal(EVENT_TYPES.indexOf('Kill'))).toBe(false);
    expect(isFatal(EVENT_TYPES.indexOf('BotKill'))).toBe(false);
    expect(isFatal(EVENT_TYPES.indexOf('Loot'))).toBe(false);
  });
});