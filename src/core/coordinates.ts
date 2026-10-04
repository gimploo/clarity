/**
 * World-coordinate -> minimap conversion.
 *
 * The transform is deliberately two-stage: world -> normalised UV, then UV ->
 * whatever pixel rectangle the image is currently drawn into. Keeping UV as the
 * intermediate means the same code works for the source minimap, the downscaled
 * web asset, a high-DPI backing store, and a letterboxed viewport.
 */
import { MAPS } from './maps';
import type { MapId } from './types';

export interface Uv {
  u: number;
  v: number;
}

export interface Pixel {
  px: number;
  py: number;
}

/**
 * World (x, z) -> normalised minimap UV.
 *
 * `y` is deliberately ignored: it is elevation in the 3D world, not a planar
 * map coordinate, so folding it in would shear every path.
 */
export function worldToUv(mapId: MapId, x: number, z: number): Uv {
  const { scale, originX, originZ } = MAPS[mapId];
  return {
    u: (x - originX) / scale,
    v: (z - originZ) / scale,
  };
}

/** Normalised UV -> pixel inside a `width` x `height` destination rectangle. */
export function uvToPixel(u: number, v: number, width: number, height: number): Pixel {
  return {
    px: u * width,
    // Y is flipped: world Z increases north, image rows increase downward.
    py: (1 - v) * height,
  };
}

/** Convenience: world -> pixel in one step. */
export function worldToPixel(
  mapId: MapId,
  x: number,
  z: number,
  width: number,
  height: number,
): Pixel {
  const { u, v } = worldToUv(mapId, x, z);
  return uvToPixel(u, v, width, height);
}

/** Inverse of {@link worldToUv}. */
export function uvToWorld(mapId: MapId, u: number, v: number): { x: number; z: number } {
  const { scale, originX, originZ } = MAPS[mapId];
  return { x: u * scale + originX, z: v * scale + originZ };
}

/**
 * Whether a UV coordinate falls inside the map. Used by the mapping verifier and
 * to flag out-of-bounds telemetry instead of silently drawing it off-canvas.
 */
export function isInsideMap(u: number, v: number, tolerance = 0): boolean {
  return u >= -tolerance && u <= 1 + tolerance && v >= -tolerance && v <= 1 + tolerance;
}

/** World-space bounds covered by a map, i.e. what the minimap depicts. */
export function worldBounds(mapId: MapId): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  const { scale, originX, originZ } = MAPS[mapId];
  return { minX: originX, maxX: originX + scale, minZ: originZ, maxZ: originZ + scale };
}