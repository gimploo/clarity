/**
 * Per-map geometry: how game world coordinates map onto a minimap image.
 *
 * `scale` and `origin` come from the map table in res/player_data/README.md.
 * The image dimensions are ours: the README claims every minimap is 1024x1024,
 * but the shipped files are 4320x4320, 2160x2158 and 9000x9000. Following the
 * README literally would place AmbroseValley entirely inside the top-left
 * quarter of the image and Lockdown almost entirely off-canvas.
 *
 * The fix is to never convert to pixels at all. Normalise to UV first, then
 * scale by whatever size the image is actually drawn at. That makes the
 * transform independent of resolution, aspect ratio and CSS layout.
 */
import type { MapId } from './types';

export interface MapConfig {
  id: MapId;
  displayName: string;
  /** World units spanned by the full 0..1 UV range. */
  scale: number;
  /** World coordinate at UV (0,0). */
  originX: number;
  /** World coordinate at UV (0,0) on the Z axis. */
  originZ: number;
  /** Natural pixel size of the *source* minimap, for reference and diagnostics. */
  sourceWidth: number;
  sourceHeight: number;
  /** Web asset filename, relative to public/minimaps/. */
  asset: string;
  /** Short description shown in the UI. */
  blurb: string;
}

export const MAPS: Record<MapId, MapConfig> = {
  AmbroseValley: {
    id: 'AmbroseValley',
    displayName: 'Ambrose Valley',
    scale: 900,
    originX: -370,
    originZ: -473,
    sourceWidth: 4320,
    sourceHeight: 4320,
    asset: 'AmbroseValley_Minimap.webp',
    blurb: 'Primary map, most matches played',
  },
  GrandRift: {
    id: 'GrandRift',
    displayName: 'Grand Rift',
    scale: 581,
    originX: -290,
    originZ: -290,
    sourceWidth: 2160,
    sourceHeight: 2158,
    asset: 'GrandRift_Minimap.webp',
    blurb: 'Secondary map, smallest world span',
  },
  Lockdown: {
    id: 'Lockdown',
    displayName: 'Lockdown',
    scale: 1000,
    originX: -500,
    originZ: -500,
    sourceWidth: 9000,
    sourceHeight: 9000,
    asset: 'Lockdown_Minimap.webp',
    blurb: 'Close-quarters map',
  },
};

export const MAP_LIST: MapConfig[] = [MAPS.AmbroseValley, MAPS.GrandRift, MAPS.Lockdown];

/** Aspect ratio (width / height) of a map's minimap image. */
export function mapAspect(config: MapConfig): number {
  return config.sourceWidth / config.sourceHeight;
}