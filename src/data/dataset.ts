/**
 * In-memory index over the loaded journeys.
 *
 * Two things happen here that the raw parquet does not give us:
 *
 *  1. Timestamps are rebased to be match-relative. The raw `ts` values sit around
 *     1.77e9 with an arbitrary offset, so absolute values are meaningless across
 *     matches. Subtracting each match's earliest timestamp makes playback and
 *     per-match duration correct.
 *
 *  2. Journeys are bucketed by match and by map, plus per-map UV bounds, so the
 *     renderer can frame the view without scanning every row.
 */
import { worldToUv } from '../core/coordinates';
import { EVENT_TYPES } from '../core/types';
import type { Journey, MapId, MatchInfo, PlayerInfo } from '../core/types';

export interface MapBounds {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  minY: number;
  maxY: number;
  journeys: number;
  rows: number;
}

export interface Dataset {
  journeys: Journey[];
  days: string[];
  maps: MapId[];
  matches: Map<string, MatchInfo>;
  players: Map<string, PlayerInfo>;
  /** Match id -> its journeys, for fast match selection. */
  byMatch: Map<string, Journey[]>;
  /** Map id -> its journeys. */
  byMap: Map<MapId, Journey[]>;
  /** Map id -> observed UV extent of the data (not of the whole minimap). */
  bounds: Map<MapId, MapBounds>;
  /** Match id -> earliest raw timestamp. */
  totals: {
    rows: number;
    journeys: number;
    humanJourneys: number;
    botJourneys: number;
    matches: number;
    players: number;
    eventTotals: number[];
  };
}

function blankBounds(): MapBounds {
  return {
    minU: Infinity,
    maxU: -Infinity,
    minV: Infinity,
    maxV: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    journeys: 0,
    rows: 0,
  };
}

/** Subtracts a match's shared zero point from every timestamp in a journey. */
function rebase(journey: Journey, matchStart: number): void {
  for (let i = 0; i < journey.t.length; i++) {
    journey.t[i] = journey.t[i]! - matchStart;
  }
  journey.t0 = journey.t[0] ?? 0;
  journey.t1 = journey.t[journey.t.length - 1] ?? 0;
}

export function buildDataset(journeys: Journey[], days: string[], maps: MapId[]): Dataset {
  const matches = new Map<string, MatchInfo>();
  const players = new Map<string, PlayerInfo>();
  const byMatch = new Map<string, Journey[]>();
  const byMap = new Map<MapId, Journey[]>();
  const bounds = new Map<MapId, MapBounds>();

  // Every participant in a match shares one zero point, so playback lines up
  // across all files that belong to the same match.
  const matchStart = new Map<string, number>();
  for (const journey of journeys) {
    const current = matchStart.get(journey.matchId);
    if (current === undefined || journey.t0 < current) {
      matchStart.set(journey.matchId, journey.t0);
    }
  }
  for (const journey of journeys) {
    rebase(journey, matchStart.get(journey.matchId) ?? 0);
  }

  // Pass 2: indexes and aggregates.
  const eventTotals = new Array<number>(EVENT_TYPES.length).fill(0);
  let rows = 0;
  let humanJourneys = 0;
  let botJourneys = 0;

  for (const journey of journeys) {
    rows += journey.x.length;
    if (journey.isBot) botJourneys++;
    else humanJourneys++;

    for (let i = 0; i < journey.e.length; i++) {
      eventTotals[journey.e[i]!] = (eventTotals[journey.e[i]!] ?? 0) + 1;
    }

    let bucket = byMatch.get(journey.matchId);
    if (!bucket) {
      bucket = [];
      byMatch.set(journey.matchId, bucket);
    }
    bucket.push(journey);

    const mapJourneys = byMap.get(journey.mapId);
    if (mapJourneys) mapJourneys.push(journey);
    else byMap.set(journey.mapId, [journey]);

    const mapBounds = bounds.get(journey.mapId) ?? blankBounds();
    mapBounds.journeys++;
    mapBounds.rows += journey.x.length;
    for (let i = 0; i < journey.x.length; i++) {
      const { u, v } = worldToUv(journey.mapId, journey.x[i]!, journey.z[i]!);
      if (u < mapBounds.minU) mapBounds.minU = u;
      if (u > mapBounds.maxU) mapBounds.maxU = u;
      if (v < mapBounds.minV) mapBounds.minV = v;
      if (v > mapBounds.maxV) mapBounds.maxV = v;
      const y = journey.y[i]!;
      if (y < mapBounds.minY) mapBounds.minY = y;
      if (y > mapBounds.maxY) mapBounds.maxY = y;
    }
    bounds.set(journey.mapId, mapBounds);

    let player = players.get(journey.userId);
    if (!player) {
      player = { userId: journey.userId, isBot: journey.isBot, matches: 0 };
      players.set(journey.userId, player);
    }
    player.matches++;
  }

  for (const [matchId, group] of byMatch) {
    const events = new Array<number>(EVENT_TYPES.length).fill(0);
    let t0 = Infinity;
    let t1 = -Infinity;
    let humans = 0;
    let bots = 0;
    for (const journey of group) {
      if (journey.t0 < t0) t0 = journey.t0;
      if (journey.t1 > t1) t1 = journey.t1;
      if (journey.isBot) bots++;
      else humans++;
      for (let i = 0; i < journey.e.length; i++) {
        events[journey.e[i]!] = (events[journey.e[i]!] ?? 0) + 1;
      }
    }
    const first = group[0]!;
    matches.set(matchId, {
      matchId,
      mapId: first.mapId,
      day: first.day,
      t0: Number.isFinite(t0) ? t0 : 0,
      t1: Number.isFinite(t1) ? t1 : 0,
      journeys: group.length,
      humans,
      bots,
      events,
    });
  }

  return {
    journeys,
    days,
    maps,
    matches,
    players,
    byMatch,
    byMap,
    bounds,
    totals: {
      rows,
      journeys: journeys.length,
      humanJourneys,
      botJourneys,
      matches: matches.size,
      players: players.size,
      eventTotals,
    },
  };
}

/** Journeys passing the current filter, in stable order. */
export function selectJourneys(dataset: Dataset, filters: {
  mapId: MapId;
  days: string[];
  matchIds: string[];
  playerId: string;
  showHumans: boolean;
  showBots: boolean;
}): Journey[] {
  const matches = filters.matchIds.length ? new Set(filters.matchIds) : null;
  const days = filters.days.length ? new Set(filters.days) : null;
  const source = dataset.byMap.get(filters.mapId) ?? [];

  const out: Journey[] = [];
  for (const journey of source) {
    if (days && !days.has(journey.day)) continue;
    if (matches && !matches.has(journey.matchId)) continue;
    if (filters.playerId && journey.userId !== filters.playerId) continue;
    if (journey.isBot && !filters.showBots) continue;
    if (!journey.isBot && !filters.showHumans) continue;
    out.push(journey);
  }
  return out;
}

/** Match ids available for a map, optionally narrowed by day. */
export function matchesFor(dataset: Dataset, mapId: MapId, days: string[]): MatchInfo[] {
  const daySet = days.length ? new Set(days) : null;
  const out: MatchInfo[] = [];
  for (const match of dataset.matches.values()) {
    if (match.mapId !== mapId) continue;
    if (daySet && !daySet.has(match.day)) continue;
    out.push(match);
  }
  out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.matchId < b.matchId ? -1 : 1));
  return out;
}

/** Players seen on a map, optionally narrowed by day. */
export function playersFor(dataset: Dataset, mapId: MapId, days: string[]): PlayerInfo[] {
  const daySet = days.length ? new Set(days) : null;
  const seen = new Map<string, PlayerInfo>();
  for (const journey of dataset.byMap.get(mapId) ?? []) {
    if (daySet && !daySet.has(journey.day)) continue;
    const player = dataset.players.get(journey.userId);
    if (player) seen.set(player.userId, player);
  }
  return [...seen.values()].sort((a, b) => (a.userId < b.userId ? -1 : 1));
}
