/**
 * Domain types for the LILA BLACK telemetry dataset.
 *
 * Everything here reflects what is actually in res/player_data, which differs
 * from the shipped data README in a few important ways. See ARCHITECTURE.md.
 */

/** The three maps in rotation. */
export const MAP_IDS = ['AmbroseValley', 'GrandRift', 'Lockdown'] as const;
export type MapId = (typeof MAP_IDS)[number];

export function isMapId(value: string): value is MapId {
  return (MAP_IDS as readonly string[]).includes(value);
}

/**
 * Raw event names as stored in the parquet `event` column.
 *
 * These are relative to the *subject* of the file, i.e. the player whose journey
 * the file describes -- not a global view of the match. A human's file contains
 * `BotKilled` when that human was killed by a bot.
 */
export const EVENT_TYPES = [
  'Position',
  'BotPosition',
  'Loot',
  'Kill',
  'Killed',
  'BotKill',
  'BotKilled',
  'KilledByStorm',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function eventIndex(name: string): number {
  const i = (EVENT_TYPES as readonly string[]).indexOf(name);
  return i === -1 ? -1 : i;
}

/** Human-readable meaning of each raw event, for the legend and tooltips. */
export const EVENT_LABELS: Record<EventType, string> = {
  Position: 'Moved (human)',
  BotPosition: 'Moved (bot)',
  Loot: 'Looted item',
  Kill: 'Killed a human',
  Killed: 'Killed by a human',
  BotKill: 'Killed a bot',
  BotKilled: 'Killed by a bot',
  KilledByStorm: 'Died to the storm',
};

/**
 * How an event is drawn. Movement is not a marker; the rest are.
 *
 * `outcome` and `other` let a Level Designer ask questions the raw event names
 * cannot answer directly, e.g. "where do players get killed by *other players*"
 * vs "where do players die to the storm".
 */
export type MarkerKind = 'kill' | 'death' | 'stormDeath' | 'loot';

export interface MarkerSpec {
  kind: MarkerKind;
  label: string;
  /** True when the event ends the subject's life. */
  fatal: boolean;
  /** True when the counterparty is a bot rather than a human. */
  vsBot: boolean;
}

export const MARKER_SPECS: Record<MarkerKind, MarkerSpec> = {
  kill: { kind: 'kill', label: 'Kill', fatal: false, vsBot: false },
  death: { kind: 'death', label: 'Death', fatal: true, vsBot: false },
  stormDeath: { kind: 'stormDeath', label: 'Storm death', fatal: true, vsBot: false },
  loot: { kind: 'loot', label: 'Loot', fatal: false, vsBot: false },
};

/** Marker kind for an event index, or null for movement samples. */
export function markerKindFor(index: number): MarkerKind | null {
  switch (EVENT_TYPES[index]) {
    case 'Loot':
      return 'loot';
    case 'Kill':
    case 'BotKill':
      return 'kill';
    case 'Killed':
    case 'BotKilled':
      return 'death';
    case 'KilledByStorm':
      return 'stormDeath';
    default:
      return null;
  }
}

/** True when the event ends the subject's life. */
export function isFatal(index: number): boolean {
  const name = EVENT_TYPES[index];
  return name === 'Killed' || name === 'BotKilled' || name === 'KilledByStorm';
}

/** True when the event is a position sample (the overwhelming majority of rows). */
export function isMovement(index: number): boolean {
  const name = EVENT_TYPES[index];
  return name === 'Position' || name === 'BotPosition';
}

/**
 * One player's journey through one match -- the contents of a single parquet file.
 *
 * Events are stored column-wise in typed arrays and sorted ascending by `t`.
 * `t` is match-relative milliseconds (the raw `ts` values carry an arbitrary
 * epoch offset that is meaningless across matches).
 */
export interface Journey {
  userId: string;
  matchId: string;
  mapId: MapId;
  /** Derived from the user_id format, which is the only reliable signal. */
  isBot: boolean;
  /** Source day folder, e.g. "February_10". */
  day: string;
  /** Parquet file path relative to public/data/. */
  source: string;
  /** Match-relative start/end time in ms. */
  t0: number;
  t1: number;
  /** World coordinates. `y` is elevation and is not used for 2D placement. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Match-relative timestamps in ms, ascending. */
  t: Float64Array;
  /** Index into EVENT_TYPES. */
  e: Uint8Array;
}

export interface MatchInfo {
  matchId: string;
  mapId: MapId;
  day: string;
  /** Match-relative start/end in ms. */
  t0: number;
  t1: number;
  journeys: number;
  humans: number;
  bots: number;
  /** Per-event-type totals across every journey in the match. */
  events: number[];
}

export interface PlayerInfo {
  userId: string;
  isBot: boolean;
  matches: number;
}

/** Heatmap channels the tool can render. */
export type HeatmapMode = 'none' | 'traffic' | 'kills' | 'deaths';

export interface Filters {
  mapId: MapId;
  /** Empty means "all days". */
  days: string[];
  /** Empty means "all matches on the selected map". */
  matchIds: string[];
  /** Restrict to a single player, or empty for all. */
  playerId: string;
  showHumans: boolean;
  showBots: boolean;
  /** Marker kinds to draw. */
  showKills: boolean;
  showDeaths: boolean;
  showLoot: boolean;
  showStormDeaths: boolean;
  heatmap: HeatmapMode;
}

/** Playback cursor. `null` means "show the whole match at once". */
export interface PlaybackState {
  matchId: string | null;
  /** Current playhead in match-relative ms, or null for static view. */
  cursor: number | null;
  playing: boolean;
  /**
   * Wall-clock length of one full replay, in seconds.
   *
   * Expressed as a target duration rather than a speed multiplier because a raw
   * match spans only 13-890 ms. A "1x" replay would be over before it registered,
   * so the only meaningful choices are "how long do I want to watch this for".
   */
  targetSeconds: number;
}