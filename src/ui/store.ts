/**
 * Minimal observable state container.
 *
 * Enough of a store to keep the panels decoupled from each other: any part of the
 * UI can subscribe and re-render on change, without the app passing callbacks
 * around or knowing which panel depends on which slice of state.
 */
import type { Filters, HeatmapMode, MapId, PlaybackState } from '../core/types';

export interface AppState {
  filters: Filters;
  playback: PlaybackState;
  selectedPlayer: string | null;
  /** Heatmap overlay opacity, 0..1. */
  heatmapAlpha: number;
  showMiniMap: boolean;
}

export function initialFilters(mapId: MapId): Filters {
  return {
    mapId,
    days: [],
    matchIds: [],
    playerId: '',
    showHumans: true,
    showBots: true,
    showKills: true,
    showDeaths: true,
    showLoot: false,
    showStormDeaths: true,
    heatmap: 'none',
  };
}

export function initialPlayback(): PlaybackState {
  return {
    matchId: null,
    cursor: null,
    playing: false,
    targetSeconds: 8,
  };
}

export class Store {
  private state: AppState;
  private listeners = new Set<(state: AppState) => void>();

  constructor(mapId: MapId) {
    this.state = {
      filters: initialFilters(mapId),
      playback: initialPlayback(),
      selectedPlayer: null,
      heatmapAlpha: 0.75,
      showMiniMap: true,
    };
  }

  get(): Readonly<AppState> {
    return this.state;
  }

  /** Applies a shallow patch to the root state. */
  update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  /** Applies a patch to the filter block only. */
  setFilters(patch: Partial<Filters>): void {
    this.state = { ...this.state, filters: { ...this.state.filters, ...patch } };
    this.emit();
  }

  setPlayback(patch: Partial<PlaybackState>): void {
    this.state = { ...this.state, playback: { ...this.state.playback, ...patch } };
    this.emit();
  }

  /** Switches map and clears any selection that cannot survive the change. */
  setMap(mapId: MapId): void {
    this.state = {
      ...this.state,
      filters: { ...this.state.filters, mapId, matchIds: [], playerId: '' },
      playback: { ...this.state.playback, matchId: null, cursor: null, playing: false },
      selectedPlayer: null,
    };
    this.emit();
  }

  setHeatmap(heatmap: HeatmapMode): void {
    this.setFilters({ heatmap });
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}