/**
 * Sidebar: filters, marker toggles, legend and aggregate stats.
 *
 * Every control writes to the store and lets the store broadcast, so there is a
 * single source of truth for what is on screen. Counts next to each filter are
 * computed against the *current* selection so it is always obvious how many
 * journeys a choice will leave behind before you commit to it.
 */
import { MAPS, mapAspect } from '../core/maps';
import { EVENT_TYPES, MARKER_SPECS } from '../core/types';
import type { HeatmapMode, Journey, MarkerKind } from '../core/types';
import { matchesFor, playersFor, selectJourneys } from '../data/dataset';
import type { Dataset } from '../data/dataset';
import { MARKER_STYLES, PALETTE } from '../render/styles';
import { clear, el, formatMs, num, prettyDay, shortId } from './dom';
import type { Store } from './store';

const HEATMAP_MODES: Array<[HeatmapMode, string]> = [
  ['none', 'Off'],
  ['traffic', 'High-traffic areas'],
  ['kills', 'Kill zones'],
  ['deaths', 'Death zones'],
];

const MARKER_ORDER: MarkerKind[] = ['kill', 'death', 'stormDeath', 'loot'];

/** Opacity as a whole percentage, so the readout never shows 0.30000000004. */
function formatAlpha(alpha: number): string {
  return `${Math.round(alpha * 100)}%`;
}

const MARKER_TOGGLE: Record<MarkerKind, 'showKills' | 'showDeaths' | 'showLoot' | 'showStormDeaths'> = {
  kill: 'showKills',
  death: 'showDeaths',
  stormDeath: 'showStormDeaths',
  loot: 'showLoot',
};

export class Sidebar {
  readonly element: HTMLElement;
  private readonly dataset: Dataset;
  private readonly store: Store;

  private daysHost!: HTMLElement;
  private matchHost!: HTMLElement;
  private playerHost!: HTMLElement;
  private subjectHost!: HTMLElement;
  private markerHost!: HTMLElement;
  private heatmapHost!: HTMLElement;
  private statsHost!: HTMLElement;
  private legendHost!: HTMLElement;

  /**
   * Live refs to the opacity control, so {@link setAlpha} can update it without
   * rebuilding the panel (issue #2).
   */
  private alphaSlider: HTMLInputElement | null = null;
  private alphaReadout: HTMLSpanElement | null = null;

  // (prompt removed)
  // private matchSelect: HTMLSelectElement | null = null;

  constructor(dataset: Dataset, store: Store) {
    this.dataset = dataset;
    this.store = store;
    this.element = el('aside', { class: 'sidebar' });
    this.build();
  }

  private build(): void {
    this.daysHost = this.section('Days');
    this.matchHost = this.section('Matches');
    this.playerHost = this.section('Player');
    this.subjectHost = this.section('Subjects');
    this.markerHost = this.section('Event markers');
    this.heatmapHost = this.section('Heatmap');
    this.legendHost = this.section('Legend');
    this.statsHost = this.section('Selection');
  }

  private section(title: string): HTMLElement {
    const body = el('div');
    this.element.append(
      el('section', {}, el('h2', { class: 'section__title' }, title), body),
    );
    return body;
  }

  render(): void {
    const { filters } = this.store.get();
    this.renderDays(filters.days);
    this.renderMatches();
    this.renderPlayers();
    this.renderSubjects();
    this.renderMarkers();
    this.renderHeatmap();
    this.renderLegend();
    this.renderStats();
  }

  // ---- filters -------------------------------------------------------------

  private renderDays(selected: string[]): void {
    clear(this.daysHost);
    const all = this.dataset.days;
    const chosen = new Set(selected);
    const allActive = selected.length === 0;

    const chips = el(
      'div',
      { class: 'chips' },
      this.dayChip('All', allActive, () =>
        this.store.setFilters({ days: [], matchIds: [], playerId: '' }),
      ),
    );

    for (const day of all) {
      chips.append(
        this.dayChip(prettyDay(day), chosen.has(day), () => {
          const next = new Set(chosen);
          if (next.has(day)) next.delete(day);
          else next.add(day);
          this.store.setFilters({
            days: [...next],
            // Match ids are day-specific, so a day change invalidates them.
            matchIds: [],
            playerId: '',
          });
        }),
      );
    }
    this.daysHost.append(chips);
  }

  private dayChip(label: string, active: boolean, onClick: () => void): HTMLElement {
    return el(
      'button',
      {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(active),
        onclick: onClick,
      },
      label,
    );
  }

  private renderMatches(): void {
    clear(this.matchHost);
    const { filters } = this.store.get();
    const available = matchesFor(this.dataset, filters.mapId, filters.days);
    const chosen = new Set(filters.matchIds);

    const select = el('select', {
      onchange: (event: Event) => {
        const value = (event.target as HTMLSelectElement).value;
        this.store.setFilters({
          matchIds: value ? [value] : [],
          playerId: '',
        });
      },
    });

    const totalJourneys = available.reduce((sum, m) => sum + m.journeys, 0);
    select.append(
      el('option', { value: '' }, `All matches (${num(available.length)})`),
      el('option', { value: '' , disabled: true }, `· ${num(totalJourneys)} journeys total`),
    );

    for (const match of available) {
      const option = el(
        'option',
        { value: match.matchId },
        `${prettyDay(match.day)} · ${shortId(match.matchId, 6, 4)} · ${match.humans}h/${match.bots}b`,
      );
      if (chosen.has(match.matchId)) option.selected = true;
      select.append(option);
    }

    // this.matchSelect = select;
    this.matchHost.append(el('label', { class: 'field' }, select));

    if (filters.matchIds.length === 1) {
      const info = this.dataset.matches.get(filters.matchIds[0]!);
      if (info) {
        this.matchHost.append(
          el(
            'p',
            { class: 'note' },
            `Duration ${formatMs(info.t1 - info.t0)} · ${info.humans} human${info.humans === 1 ? '' : 's'}, ${info.bots} bot${info.bots === 1 ? '' : 's'}`,
          ),
        );
      }
    }
  }

  private renderPlayers(): void {
    clear(this.playerHost);
    const { filters } = this.store.get();
    const available = playersFor(this.dataset, filters.mapId, filters.days);

    const select = el('select', {
      onchange: (event: Event) => {
        this.store.setFilters({ playerId: (event.target as HTMLSelectElement).value });
      },
    });

    select.append(el('option', { value: '' }, `All players (${num(available.length)})`));

    const humans = available.filter((p) => !p.isBot);
    const bots = available.filter((p) => p.isBot);

    for (const [label, group] of [
      ['Humans', humans],
      ['Bots', bots],
    ] as const) {
      if (group.length === 0) continue;
      select.append(el('option', { value: '', disabled: true }, `— ${label} —`));
      for (const player of group) {
        const option = el(
          'option',
          { value: player.userId },
          `${shortId(player.userId, 8, 4)} · ${player.matches} match${player.matches === 1 ? '' : 'es'}`,
        );
        if (filters.playerId === player.userId) option.selected = true;
        select.append(option);
      }
    }

    this.playerHost.append(el('label', { class: 'field' }, select));
  }

  private renderSubjects(): void {
    clear(this.subjectHost);
    const { filters, showPaths } = this.store.get();
    const visible = selectJourneys(this.dataset, filters);

    let humans = 0;
    let bots = 0;
    for (const journey of visible) {
      if (journey.isBot) bots++;
      else humans++;
    }

    this.subjectHost.append(
      this.checkRow({
        label: 'Humans',
        color: PALETTE.human,
        count: humans,
        checked: filters.showHumans,
        onChange: (checked) => this.store.setFilters({ showHumans: checked }),
      }),
      this.checkRow({
        label: 'Bots',
        color: PALETTE.bot,
        count: bots,
        checked: filters.showBots,
        onChange: (checked) => this.store.setFilters({ showBots: checked }),
      }),
      el(
        'label',
        { class: 'check' },
        el('input', {
          type: 'checkbox',
          checked: showPaths,
          onchange: (event: Event) =>
            this.store.update({ showPaths: (event.target as HTMLInputElement).checked }),
        }),
        'Show paths',
      ),
    );
  }

  private renderMarkers(): void {
    clear(this.markerHost);
    const { filters } = this.store.get();
    const visible = selectJourneys(this.dataset, filters);
    const counts = this.markerCounts(visible);

    for (const kind of MARKER_ORDER) {
      const style = MARKER_STYLES[kind];
      this.markerHost.append(
        this.checkRow({
          label: `${MARKER_SPECS[kind].label}`,
          color: style.color,
          count: counts[kind],
          checked: filters[MARKER_TOGGLE[kind]],
          onChange: (checked) => this.store.setFilters({ [MARKER_TOGGLE[kind]]: checked }),
        }),
      );
    }

    this.markerHost.append(
      el(
        'p',
        { class: 'note' },
        'Counts are for the current selection. Loot is dense, so it is off by default.',
      ),
    );
  }

  private renderHeatmap(): void {
    clear(this.heatmapHost);
    const { filters, heatmapAlpha } = this.store.get();

    const select = el('select', {
      onchange: (event: Event) =>
        this.store.setHeatmap((event.target as HTMLSelectElement).value as HeatmapMode),
    });
    for (const [value, label] of HEATMAP_MODES) {
      const option = el('option', { value }, label);
      if (filters.heatmap === value) option.selected = true;
      select.append(option);
    }
    this.heatmapHost.append(el('label', { class: 'field' }, select));

    const slider = el('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(heatmapAlpha),
      disabled: filters.heatmap === 'none',
      oninput: (event: Event) =>
        this.store.setHeatmapAlpha(Number((event.target as HTMLInputElement).value)),
    });
    slider.className = 'slider';

    const readout = el('span', { class: 'field__value' }, formatAlpha(heatmapAlpha));
    this.alphaSlider = slider;
    this.alphaReadout = readout;

    this.heatmapHost.append(
      el(
        'label',
        { class: 'field' },
        el(
          'span',
          { class: 'field__head' },
          el('span', { class: 'field__label' }, 'Opacity'),
          readout,
        ),
        slider,
      ),
    );
  }

  /**
   * Repaints only the opacity control.
   *
   * Called from the store's alpha channel while the slider is being dragged. The
   * panel rebuild in {@link render} is reserved for changes that can actually
   * alter a filter, a count or the disabled state of this control.
   */
  setAlpha(alpha: number): void {
    if (this.alphaSlider) this.alphaSlider.value = String(alpha);
    if (this.alphaReadout) this.alphaReadout.textContent = formatAlpha(alpha);
  }

  // ---- read-only panels ----------------------------------------------------

  private renderLegend(): void {
    clear(this.legendHost);

    this.legendHost.append(
      this.legendRow(PALETTE.humanPath, 'Human journey'),
      this.legendRow(PALETTE.botPath, 'Bot journey'),
    );

    for (const kind of MARKER_ORDER) {
      const style = MARKER_STYLES[kind];
      const glyph = el('span', { class: 'legend__glyph' });
      glyph.style.background = style.color;
      glyph.dataset.shape = style.shape;
      this.legendHost.append(el('div', { class: 'legend__row' }, glyph, style.description));
    }

    this.legendHost.append(
      el(
        'p',
        { class: 'note' },
        'Events are stored per player, so a kill appears in the killer’s file and the death in the victim’s file. Both are drawn.',
      ),
    );
  }

  private legendRow(color: string, label: string): HTMLElement {
    const line = el('span', { class: 'legend__line' });
    line.style.background = color;
    return el('div', { class: 'legend__row' }, line, label);
  }

  private renderStats(): void {
    clear(this.statsHost);
    const { filters } = this.store.get();
    const visible = selectJourneys(this.dataset, filters);
    const counts = this.markerCounts(visible);

    let rows = 0;
    let humans = 0;
    let bots = 0;
    const matchIds = new Set<string>();
    const playerIds = new Set<string>();
    for (const journey of visible) {
      rows += journey.x.length;
      if (journey.isBot) bots++;
      else humans++;
      matchIds.add(journey.matchId);
      playerIds.add(journey.userId);
    }

    const config = MAPS[filters.mapId];
    const rows_: Array<[string, string]> = [
      ['Journeys', num(visible.length)],
      ['Players', num(playerIds.size)],
      ['Matches', num(matchIds.size)],
      ['Humans', num(humans)],
      ['Bots', num(bots)],
      ['Samples', num(rows)],
      ['Kills', num(counts.kill)],
      ['Deaths', num(counts.death + counts.stormDeath)],
      ['Loot', num(counts.loot)],
      ['Map size', `${num(config.scale)} u`],
      ['Minimap', `${config.sourceWidth}x${config.sourceHeight} (${mapAspect(config).toFixed(2)}:1)`],
    ];

    const list = el('dl', { class: 'stat-grid' });
    for (const [key, value] of rows_) {
      list.append(el('dt', {}, key), el('dd', {}, value));
    }
    this.statsHost.append(list);
  }

  // ---- helpers -------------------------------------------------------------

  private markerCounts(journeys: Journey[]): Record<MarkerKind, number> {
    const counts: Record<MarkerKind, number> = { kill: 0, death: 0, stormDeath: 0, loot: 0 };
    for (const journey of journeys) {
      for (let i = 0; i < journey.e.length; i++) {
        const name = EVENT_TYPES[journey.e[i]!];
        switch (name) {
          case 'Kill':
          case 'BotKill':
            counts.kill++;
            break;
          case 'Killed':
          case 'BotKilled':
            counts.death++;
            break;
          case 'KilledByStorm':
            counts.stormDeath++;
            break;
          case 'Loot':
            counts.loot++;
            break;
        }
      }
    }
    return counts;
  }

  private checkRow(options: {
    label: string;
    color: string;
    count: number;
    checked: boolean;
    onChange: (checked: boolean) => void;
  }): HTMLElement {
    const input = el('input', {
      type: 'checkbox',
      checked: options.checked,
      onchange: (event: Event) =>
        options.onChange((event.target as HTMLInputElement).checked),
    });
    const swatch = el('span', { class: 'check__swatch' });
    swatch.style.background = options.color;
    return el(
      'label',
      { class: 'check' },
      input,
      swatch,
      options.label,
      el('span', { class: 'check__hint' }, num(options.count)),
    );
  }
}
