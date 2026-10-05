/**
 * Match playback timeline.
 *
 * Raw telemetry for an entire match spans 13-890 ms, so a literal 1x replay is
 * over in under a second. Rather than exposing a confusing "0.05x" multiplier,
 * the control is expressed as the wall-clock length of a full replay, which is
 * the thing a Level Designer actually wants to reason about.
 *
 * The scrubber doubles as an event strip: kills are ticked along the top edge,
 * deaths along the bottom, so the shape of a fight is visible before pressing play.
 */
import { markerKindFor } from '../core/types';
import type { Journey } from '../core/types';
import { MARKER_STYLES } from '../render/styles';
import { clear, el, formatMs } from './dom';
import type { Store } from './store';

/** Replay lengths offered, in wall-clock seconds. */
const DURATIONS = [2, 4, 8, 16, 30];

export class Timeline {
  readonly element: HTMLElement;
  private readonly store: Store;
  private readonly journeys: () => Journey[];

  private readonly track: HTMLElement;
  private readonly ticks: HTMLElement;
  private readonly head: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly readout: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly durationSelect: HTMLSelectElement;

  /** Signature of everything that requires rebuilding DOM, not just repositioning. */
  private structural = '';

  private raf = 0;
  private lastTick = 0;

  constructor(store: Store, journeys: () => Journey[]) {
    this.store = store;
    this.journeys = journeys;

    this.playButton = el(
      'button',
      { class: 'btn', type: 'button', onclick: () => this.togglePlay() },
      'Play',
    );

    const startButton = el(
      'button',
      { class: 'btn', type: 'button', onclick: () => this.store.setPlayback({ cursor: 0 }) },
      'Reset',
    );

    this.durationSelect = el('select', {
      title: 'Wall-clock length of one full replay',
      onchange: (event: Event) =>
        this.store.setPlayback({ targetSeconds: Number((event.target as HTMLSelectElement).value) }),
    }) as HTMLSelectElement;
    for (const seconds of DURATIONS) {
      this.durationSelect.append(el('option', { value: String(seconds) }, `${seconds}s`));
    }

    this.slider = el('input', {
      type: 'range',
      class: 'timeline__input',
      min: '0',
      max: '1000',
      step: '1',
      value: '0',
      oninput: (event: Event) => this.seekFraction(Number((event.target as HTMLInputElement).value) / 1000),
    }) as HTMLInputElement;

    this.empty = el(
      'div',
      { class: 'timeline__empty' },
      'Select one match to replay it across every participant',
    );
    this.ticks = el('div', { class: 'timeline__events' });
    this.head = el('div', { class: 'timeline__head' });
    this.track = el('div', { class: 'timeline__track' }, this.empty, this.ticks, this.slider, this.head);

    this.readout = el('div', { class: 'timeline__readout' }, '—');
    this.meta = el('div', { class: 'timeline__meta' });

    this.element = el(
      'footer',
      { class: 'timeline' },
      el('div', { class: 'timeline__controls' }, this.playButton, startButton),
      el('div', {}, this.track, this.meta),
      this.readout,
    );

    store.subscribe(() => this.render());
  }

  render(): void {
    const { playback } = this.store.get();
    const journeys = this.journeys();
    const span = this.span(journeys);
    const usable = span > 0;

    this.playButton.disabled = !usable;
    this.playButton.textContent = playback.playing ? 'Pause' : 'Play';
    this.playButton.setAttribute('aria-pressed', String(playback.playing));
    this.slider.disabled = !usable;
    this.durationSelect.disabled = !usable;
    this.durationSelect.value = String(playback.targetSeconds);

    // Rebuilding the tick strip means up to 600 DOM nodes, which is far too
    // expensive to redo on every animation frame. Only do it when the selection
    // or replay settings actually change.
    const signature = `${span}|${journeys.length}|${playback.targetSeconds}|${usable}`;
    if (signature !== this.structural) {
      this.structural = signature;
      this.empty.hidden = usable;
      this.head.style.display = usable ? '' : 'none';
      clear(this.ticks);
      clear(this.meta);
      if (usable) {
        this.renderTicks(journeys, span);
        this.renderMeta(journeys, span);
      }
    }

    if (!usable) {
      this.readout.textContent = '—';
      return;
    }

    const cursor = playback.cursor ?? 0;
    const fraction = span === 0 ? 0 : Math.min(1, Math.max(0, cursor / span));
    this.head.style.left = `${fraction * 100}%`;

    // Don't fight the user while they are dragging the scrubber.
    if (document.activeElement !== this.slider) {
      this.slider.value = String(Math.round(fraction * 1000));
    }
    this.readout.textContent = `${formatMs(cursor)} / ${formatMs(span)}`;
  }

  private renderTicks(journeys: Journey[], span: number): void {
    // Dense selections would put thousands of 2px ticks on screen, so cap it.
    const budget = 600;
    let placed = 0;

    for (const journey of journeys) {
      for (let i = 0; i < journey.e.length; i++) {
        const kind = markerKindFor(journey.e[i]!);
        if (!kind || kind === 'loot') continue;
        if (placed >= budget) return;

        const tick = el('span', {
          class: kind === 'kill' ? 'timeline__ev' : 'timeline__ev timeline__ev--death',
        });
        tick.style.left = `${Math.min(100, (journey.t[i]! / span) * 100)}%`;
        tick.style.background = MARKER_STYLES[kind].color;
        this.ticks.append(tick);
        placed++;
      }
    }
  }

  private renderMeta(journeys: Journey[], span: number): void {
    let kills = 0;
    let deaths = 0;
    for (const journey of journeys) {
      for (let i = 0; i < journey.e.length; i++) {
        const kind = markerKindFor(journey.e[i]!);
        if (kind === 'kill') kills++;
        else if (kind === 'death' || kind === 'stormDeath') deaths++;
      }
    }

    const items = [
      `${journeys.length} journeys`,
      `${kills} kills`,
      `${deaths} deaths`,
      `${(span / 1000).toFixed(2)}s match span`,
    ];
    for (const item of items) this.meta.append(el('span', {}, item));
  }

  // ---- playback control ----------------------------------------------------

  /**
 * Replay span for the current selection.
 *
 * Works for a whole match, not just one player: every journey in a match is
 * rebased onto a shared zero point, so the union of their `t0..t1` is the match
 * span and the playhead stays meaningful across all participants. Returns 0 when
 * the selection spans more than one match, since a shared cursor would be
 * comparing unrelated matches.
 */
  private span(journeys: Journey[]): number {
    if (journeys.length === 0) return 0;

    const matchId = journeys[0]!.matchId;
    let min = Infinity;
    let max = -Infinity;
    for (const journey of journeys) {
      if (journey.matchId !== matchId) return 0;
      if (journey.t0 < min) min = journey.t0;
      if (journey.t1 > max) max = journey.t1;
    }

    const span = max - min;
    return Number.isFinite(span) && span > 0 ? span : 0;
  }

  private seekFraction(fraction: number): void {
    const span = this.span(this.journeys());
    if (span <= 0) return;
    this.store.setPlayback({ cursor: span * Math.min(1, Math.max(0, fraction)) });
  }

  private togglePlay(): void {
    const { playback } = this.store.get();
    if (playback.playing) {
      this.stop();
      return;
    }

    const span = this.span(this.journeys());
    if (span <= 0) return;

    // Restart from the top when the playhead is already parked at the end.
    if ((playback.cursor ?? 0) >= span) this.store.setPlayback({ cursor: 0 });
    this.store.setPlayback({ playing: true });
    this.lastTick = performance.now();
    this.tick();
  }

  private tick = (): void => {
    if (!this.store.get().playback.playing) return;

    const span = this.span(this.journeys());
    if (span <= 0) {
      this.stop();
      return;
    }

    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;

    // Convert wall-clock elapsed time into match time for the chosen replay
    // length, so a 400 ms match shown over 8s advances at 400/8000 per ms.
    const { targetSeconds } = this.store.get().playback;
    const rate = span / (targetSeconds * 1000);
    const next = (this.store.get().playback.cursor ?? 0) + dt * rate;

    if (next >= span) {
      this.store.setPlayback({ cursor: span, playing: false });
      this.raf = 0;
      return;
    }

    this.store.setPlayback({ cursor: next });
    this.raf = requestAnimationFrame(this.tick);
  };

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.store.get().playback.playing) this.store.setPlayback({ playing: false });
  }
}
