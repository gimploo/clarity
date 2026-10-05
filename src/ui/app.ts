/**
 * Application shell: wires the store, panels, canvas and playback together.
 *
 * The flow is deliberately one-directional. An interaction writes to the store,
 * the store broadcasts, and `render()` recomputes the selection and repaints. No
 * panel reads another panel's DOM, which keeps the filter panel, map and timeline
 * independent of each other.
 */
import { MAPS, MAP_LIST } from '../core/maps';
import type { HeatmapMode, MapId } from '../core/types';
import { matchesFor, selectJourneys } from '../data/dataset';
import type { Dataset } from '../data/dataset';
import type { Journey } from '../core/types';
import type { LoadStats } from '../data/loader';
import { assetUrl } from '../data/loader';
import { HeatmapLayer } from '../render/heatmap';
import { Scene } from '../render/scene';
import type { SceneInput } from '../render/scene';
import { el, num } from './dom';
import { Sidebar } from './sidebar';
import { Store } from './store';
import { Timeline } from './timeline';
import { Tooltip } from './tooltip';

export class App {
  private readonly dataset: Dataset;
  private readonly loadStats: LoadStats;
  private readonly store: Store;
  private readonly scene: Scene;
  private readonly sidebar: Sidebar;
  private readonly timeline: Timeline;
  private readonly tooltip: Tooltip;
  private readonly heatmap = new HeatmapLayer();

  private readonly stage!: HTMLElement;
  private readonly canvasHost!: HTMLElement;
  private readonly tabHost!: HTMLElement;
  private readonly statHost!: HTMLElement;

  private frame = 0;
  private resizeObserver!: ResizeObserver;
  /** Map the viewport/heatmap state is currently synced to. */
  private lastMap: MapId | null = null;

  constructor(root: HTMLElement, dataset: Dataset, loadStats: LoadStats) {
    this.dataset = dataset;
    this.loadStats = loadStats;

    const firstMap = (dataset.maps[0] ?? 'AmbroseValley') as MapId;
    this.store = new Store(firstMap);

    const canvas = el('canvas');
    this.canvasHost = el('div', { class: 'canvas-host' }, canvas);
    this.stage = el('div', { class: 'stage' }, this.canvasHost);
    this.tabHost = el('div', { class: 'tabs', role: 'tablist' });
    this.statHost = el('div', { class: 'topbar__stats' });

    this.scene = new Scene(canvas);
    this.tooltip = new Tooltip(this.canvasHost);
    this.sidebar = new Sidebar(dataset, this.store);
    this.timeline = new Timeline(this.store, () => this.selection());

    root.replaceChildren(this.layout());

    this.store.subscribe(() => this.render());
    // Opacity gets its own path: it fires on every pixel of slider travel and
    // cannot change a filter, a count or the tab badges, so it must not trigger
    // a full panel rebuild (issue #2).
    this.store.onAlpha((alpha) => {
      this.sidebar.setAlpha(alpha);
      this.requestRender();
    });
    this.bindCanvas(canvas);
    this.bindKeyboard();

    this.resizeObserver = new ResizeObserver(() => {
      this.scene.resize(this.store.get().filters.mapId);
      this.requestRender();
    });
    this.resizeObserver.observe(this.stage);

    // Populate the panels immediately rather than waiting for start(). The boot
    // overlay covers the screen until start() resolves, but relying on that hides
    // a blank frame behind the overlay instead of never creating it.
    this.render();
  }

  /**
   * Renders the first frame and kicks off minimap loading.
   *
   * Resolves only once a frame has actually been painted, so the boot overlay is
   * never lifted to reveal an empty canvas.
   */
  async start(): Promise<void> {
    this.scene.resize(this.store.get().filters.mapId);
    await this.ensureMinimap(this.store.get().filters.mapId);
    this.render();
    await this.nextFrame();
  }

  /** Resolves after the next animation frame, i.e. after any pending draw. */
  private nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
  }

  // ---- layout --------------------------------------------------------------

  private layout(): HTMLElement {
    const topbar = el(
      'header',
      { class: 'topbar' },
      el('span', { class: 'topbar__brand' }, 'Clarity'),
      el('span', { class: 'topbar__tag' }, 'Player journey dashboard'),
      this.tabHost,
      el('div', { class: 'topbar__spacer' }),
      this.statHost,
    );


    return el('div', { class: 'app' }, topbar, el('div', { class: 'main' }, this.sidebar.element, this.stage), this.timeline.element);
  }



  // ---- selection -----------------------------------------------------------

  /** Journeys matching the current filters. */
  private selection() {
    return selectJourneys(this.dataset, this.store.get().filters);
  }

  /**
   * Ensures the minimap for a map is loaded.
   *
   * Viewport sizing is deliberately *not* done here: it must also run when
   * switching back to a map whose image is already cached, and keying that off
   * load success would skip the aspect update.
   */
  private async ensureMinimap(mapId: MapId): Promise<void> {
    if (this.scene.hasMinimap(mapId)) return;
    await this.scene.loadMinimap(mapId, assetUrl(`minimaps/${MAPS[mapId].asset}`));
    this.requestRender();
  }

  // ---- canvas interaction --------------------------------------------------

  private bindCanvas(canvas: HTMLCanvasElement): void {
    // There is no zoom or pan (issue #3), so a pointer gesture has nothing to drag
    // and every press is a selection.
    canvas.addEventListener('pointermove', (event) => {
      this.updateHover(event);
    });

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.selectAt(event);
    });

    canvas.addEventListener('pointerleave', () => this.tooltip.hide());
  }

  private sceneInput(): SceneInput {
    const state = this.store.get();
    return {
      mapId: state.filters.mapId,
      journeys: this.selection(),
      showHumans: state.filters.showHumans,
      showBots: state.filters.showBots,
      showKills: state.filters.showKills,
      showDeaths: state.filters.showDeaths,
      showLoot: state.filters.showLoot,
      showStormDeaths: state.filters.showStormDeaths,
      heatmap: this.heatmap,
      heatmapAlpha: state.filters.heatmap === 'none' ? 0 : state.heatmapAlpha,
      showPaths: state.showPaths,
      cursor: state.playback.cursor,
    };
  }

  private updateHover(event: PointerEvent): void {
    const input = this.sceneInput();
    const target = this.scene.pick(input, event.clientX, event.clientY);
    if (!target) {
      this.tooltip.hide();
      return;
    }
    const rect = this.canvasHost.getBoundingClientRect();
    this.tooltip.show(target, event.clientX - rect.left, event.clientY - rect.top);
  }

  /** Selects a player. Clicking the same player again clears the selection. */
  private selectAt(event: PointerEvent): void {
    const input = this.sceneInput();
    // A click is a coarser gesture than a hover, so it gets a wider grab area.
    const target = this.scene.pick(input, event.clientX, event.clientY, 1.4);
    if (!target) return;

    const userId = target.journey.userId;
    const current = this.store.get().selectedPlayer;

    if (current === userId) {
      this.store.update({ selectedPlayer: null });
      return;
    }

    // Focusing a player is much more useful scoped to one match, so when no
    // match is chosen yet, narrow the filter to the match they were picked in.
    if (this.store.get().filters.matchIds.length === 0) {
      this.store.setFilters({ matchIds: [target.journey.matchId] });
    }
    this.store.update({ selectedPlayer: userId });
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

      switch (event.key) {
        case 'Escape':
          this.store.update({ selectedPlayer: null });
          break;
      }
    });
  }

  // ---- rendering -----------------------------------------------------------

  private requestRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private render(): void {
    this.renderTabs();
    this.renderStats();
    this.sidebar.render();
    this.timeline.render();

    const { filters } = this.store.get();
    if (filters.mapId !== this.lastMap) {
      this.lastMap = filters.mapId;
      this.scene.resize(filters.mapId);
      void this.ensureMinimap(filters.mapId);
    }

    this.requestRender();
  }

  private draw(): void {
    const { filters } = this.store.get();
    const journeys = this.selection();

    this.updateHeatmap(journeys, filters.heatmap);
    this.scene.render(this.sceneInput());
  }

  /**
   * Rebuilds the heatmap only when the inputs that affect it have changed.
   *
   * Accumulating up to ~60k samples is fast but not free, and this would otherwise
   * run on every playback frame.
   */
  private updateHeatmap(journeys: Journey[], mode: HeatmapMode): void {
    const { filters } = this.store.get();
    const signature = [
      filters.mapId,
      mode,
      filters.days.join(','),
      filters.matchIds.join(','),
      filters.playerId,
      filters.showHumans,
      filters.showBots,
      journeys.length,
    ].join('|');

    if (this.heatmap.matches(signature)) return;
    this.heatmap.build(journeys, filters.heatmap, signature);
  }

  private renderTabs(): void {
    const { filters } = this.store.get();

    this.tabHost.replaceChildren();
    for (const config of MAP_LIST) {
      // Count per config, not per the currently selected map: filtering through
      // matchesFor() with the active mapId would make every other tab read zero.
      const count = matchesFor(this.dataset, config.id, []).length;
      const tab = el(
        'button',
        {
          class: 'tab',
          type: 'button',
          role: 'tab',
          'aria-selected': String(filters.mapId === config.id),
          onclick: () => this.store.setMap(config.id),
        },
        config.displayName,
        el('span', { class: 'tab__meta' }, `${count} matches`),
      );
      this.tabHost.append(tab);
    }
  }

  private renderStats(): void {
    const journeys = this.selection();
    let rows = 0;
    let humans = 0;
    let bots = 0;
    for (const journey of journeys) {
      rows += journey.x.length;
      if (journey.isBot) bots++;
      else humans++;
    }

    const items: Array<[string, string]> = [
      ['journeys', num(journeys.length)],
      ['samples', num(rows)],
      ['human/bot', `${humans}/${bots}`],
    ];
    if (this.loadStats.degraded) {
      items.push(['transfer', 'whole files']);
    } else {
      items.push(['load', `${(this.loadStats.loadMs / 1000).toFixed(1)}s`]);
    }

    this.statHost.replaceChildren();
    for (const [label, value] of items) {
      this.statHost.append(el('span', {}, `${label} `, el('b', {}, value)));
    }
  }
}
