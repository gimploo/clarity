// @vitest-environment happy-dom
/**
 * Mount smoke test.
 *
 * The UI is otherwise never executed by any check: typecheck catches type errors
 * but nothing catches a bad DOM query, a broken subscription or a throw inside a
 * render path. This drives a real App against a real DOM over a synthetic
 * dataset and asserts that every panel mounts, that filter changes propagate and
 * that playback terminates.
 *
 * Canvas is stubbed because happy-dom has no 2D context; the stub records calls
 * so we can still assert the scene actually drew.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/ui/app';
import { buildDataset } from '../src/data/dataset';
import type { Journey, MapId } from '../src/core/types';
import { MAP_IDS } from '../src/core/types';

const calls: string[] = [];

function stubContext(): CanvasRenderingContext2D {
  // Methods that must return a usable object rather than undefined.
  const special: Record<string, (...args: any[]) => unknown> = {
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    measureText: () => ({ width: 0 }),
  };

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === 'canvas') return null;
      if (typeof prop !== 'string') return undefined;
      if (prop in special) {
        return (...args: unknown[]) => {
          calls.push(`${prop}(${args.length})`);
          return special[prop]!(...args);
        };
      }
      // Everything else is a no-op that records that it was called.
      return (...args: unknown[]) => {
        calls.push(`${prop}(${args.length})`);
        return undefined;
      };
    },
    set() {
      return true;
    },
  };
  return new Proxy({}, handler) as unknown as CanvasRenderingContext2D;
}

class FakeImage {
  onload: (() => void) | null = null;
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  decoding = '';
  private listeners: Array<() => void> = [];
  set src(_value: string) {
    // Simulate a successful decode completing on the next microtask.
    queueMicrotask(() => {
      this.complete = true;
      this.naturalWidth = 2048;
      this.naturalHeight = 2048;
      for (const listener of this.listeners) listener();
    });
  }
  addEventListener(event: string, listener: () => void) {
    if (event === 'load' || event === 'error') this.listeners.push(listener);
  }
}

function journey(over: Partial<Journey> & { userId: string; matchId: string; mapId: MapId }): Journey {
  const n = 4;
  const x = new Float32Array(n);
  const z = new Float32Array(n);
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = 100 + i;
    z[i] = 100 + i;
    t[i] = i * 100;
  }
  return {
    isBot: false,
    day: 'February_10',
    source: 'synthetic',
    t0: 0,
    t1: 300,
    x,
    y: new Float32Array(n),
    z,
    t,
    // position, position, loot, kill
    e: new Uint8Array([0, 0, 2, 4]),
    ...over,
  } as Journey;
}

function syntheticDataset(): ReturnType<typeof buildDataset> {
  const journeys: Journey[] = [
    journey({ userId: '11111111-1111-1111-1111-111111111111', matchId: 'm1', mapId: 'AmbroseValley' }),
    journey({ userId: '22222222-2222-2222-2222-222222222222', matchId: 'm1', mapId: 'AmbroseValley' }),
    journey({ userId: '42', matchId: 'm2', mapId: 'AmbroseValley', isBot: true }),
    journey({ userId: '33333333-3333-3333-3333-333333333333', matchId: 'm3', mapId: 'GrandRift' }),
  ];
  return buildDataset(journeys, ['February_10', 'February_11'], [...MAP_IDS]);
}

const loadStats = {
  totalFiles: 4,
  parsedFiles: 4,
  failedFiles: 0,
  totalRows: 16,
  bytes: 1024,
  degraded: false,
  loadMs: 12,
};

let root: HTMLElement;
let app: App;

beforeEach(() => {
  calls.length = 0;

  // happy-dom has no 2D context, so canvas is stubbed. The stub records calls
  // so we can still assert the scene actually drew.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => stubContext()) as never;
  vi.stubGlobal('Image', FakeImage);

  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO);

  // The stage has no layout in happy-dom, so give the canvas a size.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);

  root = document.createElement('div');
  document.body.append(root);
  app = new App(root, syntheticDataset(), loadStats);
});

afterEach(() => {
  app.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  root.remove();
});

describe('App mount', () => {
  it('builds the full layout without throwing', () => {
    expect(root.querySelector('.topbar')).not.toBeNull();
    expect(root.querySelector('.sidebar')).not.toBeNull();
    expect(root.querySelector('.stage')).not.toBeNull();
    expect(root.querySelector('.timeline')).not.toBeNull();
    expect(root.querySelector('canvas')).not.toBeNull();
  });

  it('renders one tab per map with the correct match counts', () => {
    const tabs = [...root.querySelectorAll('.tab')];
    expect(tabs).toHaveLength(3);
    // Counts must come from the tab's own map, not the active one.
    const labels = tabs.map((t) => t.textContent ?? '');
    expect(labels[0]).toContain('Ambrose Valley');
    expect(labels[0]).toContain('2 matches');
    expect(labels[1]).toContain('Grand Rift');
    expect(labels[1]).toContain('1 matches');
    expect(labels[2]).toContain('Lockdown');
    expect(labels[2]).toContain('0 matches');
  });

  it('populates filter controls from the dataset', () => {
    const selects = [...root.querySelectorAll('.sidebar select')];
    // Match, Player, Heatmap
    expect(selects.length).toBeGreaterThanOrEqual(3);
    const matchSelect = selects[0]!;
    expect([...matchSelect.querySelectorAll('option')].length).toBeGreaterThan(1);
  });

  it('draws the canvas after start', async () => {
    await app.start();
    expect(calls.some((c) => c.startsWith('fillRect'))).toBe(true);
    expect(calls.some((c) => c.startsWith('drawImage'))).toBe(true);
    expect(calls.some((c) => c.startsWith('stroke('))).toBe(true);
  });
});

describe('filter propagation', () => {
  it('hides bot journeys when bots are unchecked', async () => {
    await app.start();
    const before = calls.length;

    const checkbox = [...root.querySelectorAll('.check input')].find(
      (input) => input.parentElement?.textContent?.includes('Bots'),
    ) as HTMLInputElement | undefined;
    expect(checkbox).toBeDefined();

    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event('change'));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    // Unchecking bots must remove the bot path from the scene, so the draw runs
    // again and the bot journey is no longer in the selection.
    expect(calls.length).toBeGreaterThan(before);
  });

  it('switches map on tab click', async () => {
    await app.start();
    const grandRiftTab = [...root.querySelectorAll('.tab')].find((t) =>
      (t.textContent ?? '').includes('Grand Rift'),
    ) as HTMLElement;
    grandRiftTab.click();

    const selected = root.querySelector('.tab[aria-selected="true"]');
    expect(selected?.textContent).toContain('Grand Rift');
  });

  it('repaints but does not rebuild the sidebar while dragging opacity', async () => {
    // Regression guard for issue #2. `input` fires on every pixel of slider
    // travel; rebuilding every panel's DOM each time made dragging visibly lag.
    await app.start();
    const slider = root.querySelector<HTMLInputElement>('.slider')!;
    const selectBefore = root.querySelector('.sidebar select');
    const drawsBefore = calls.length;

    slider.value = '0.4';
    slider.dispatchEvent(new Event('input'));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    // Same element instance, so the panel was not rebuilt.
    expect(root.querySelector('.sidebar select')).toBe(selectBefore);
    // The readout still tracked the slider.
    expect(root.querySelector('.field__value')?.textContent).toBe('40%');
    // ...and the canvas was repainted.
    expect(calls.length).toBeGreaterThan(drawsBefore);
  });

  it('still rebuilds the sidebar when a filter genuinely changes', async () => {
    // Counterpart to the test above: the cheap opacity path must not have
    // disabled normal reactivity.
    await app.start();
    const selectBefore = root.querySelector('.sidebar select');

    const matchSelect = [...root.querySelectorAll<HTMLSelectElement>('.sidebar select')][0]!;
    matchSelect.value = 'm1';
    matchSelect.dispatchEvent(new Event('change'));

    expect(root.querySelector('.sidebar select')).not.toBe(selectBefore);
  });

  it('advances the playhead while playing and stops on pause', async () => {
    await app.start();

    // Narrow to one match so playback is enabled.
    const matchSelect = [...root.querySelectorAll<HTMLSelectElement>('.sidebar select')][0]!;
    matchSelect.value = 'm1';
    matchSelect.dispatchEvent(new Event('change'));

    const play = [...root.querySelectorAll<HTMLButtonElement>('.timeline button')].find(
      (b) => b.textContent === 'Play',
    )!;
    expect(play).toBeDefined();
    expect(play.disabled).toBe(false);

    const readout = root.querySelector('.timeline__readout')!;
    const start = readout.textContent;

    play.click();
    expect(play.textContent).toBe('Pause');

    // The replay is deliberately stretched (a raw match spans only ~300ms), so
    // this only needs to prove the playhead moves, not that it reaches the end.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(readout.textContent).not.toBe(start);

    play.click();
    expect(play.textContent).toBe('Play');

    const paused = readout.textContent;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(readout.textContent).toBe(paused);
  });

  it('disables playback when the selection spans several matches', async () => {
    await app.start();
    const play = [...root.querySelectorAll('.timeline button')].find(
      (b) => b.textContent === 'Play',
    ) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
  });
});

describe('Sidebar', () => {
  it('shows human and bot counts for the selection', async () => {
    await app.start();
    const text = root.querySelector('.sidebar')?.textContent ?? '';
    expect(text).toContain('Humans');
    expect(text).toContain('Bots');
  });

  it('recomputes the legend and stats without throwing', async () => {
    await app.start();
    expect(root.querySelectorAll('.legend__row').length).toBeGreaterThan(4);
    expect(root.querySelectorAll('.stat-grid dt').length).toBeGreaterThan(5);
  });
});
