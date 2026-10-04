/**
 * Bootstrap: load the telemetry, then mount the UI.
 *
 * Loading is slow on a cold cache (over a thousand parquet files), so the boot
 * screen reports real progress rather than showing an indeterminate spinner.
 *
 * The boot overlay is kept in the DOM and hidden rather than removed, because a
 * dropped dataset (issue #5) has to load through the same progress UI and then
 * replace the running app.
 */
import './styles.css';
import { loadDataset, loadFrom, localSource } from './data/loader';
import type { DroppedFile, LoadProgress, LoadStats } from './data/loader';
import { buildDataset } from './data/dataset';
import type { Journey, MapId } from './core/types';
import { App } from './ui/app';
import { enableDropzone } from './ui/dropzone';
import { el, num, qs } from './ui/dom';

const PHASE_TEXT: Record<LoadProgress['phase'], string> = {
  manifest: 'Reading manifest…',
  probing: 'Checking range-request support…',
  fetching: 'Loading telemetry…',
  indexing: 'Building index…',
  done: 'Ready',
  failed: 'Failed',
};

/** Overrides the fetching label so a local drop does not claim to be over HTTP. */
let loadingLabel = PHASE_TEXT.fetching;

let currentApp: App | null = null;
let dropzoneTeardown: (() => void) | null = null;

function render(progress: LoadProgress): void {
  const fill = qs<HTMLElement>('#boot-fill');
  const status = qs<HTMLElement>('#boot-status');

  const fraction = progress.total > 0 ? progress.loaded / progress.total : 0;
  fill.style.width = `${Math.round(fraction * 100)}%`;

  if (progress.phase === 'done') {
    status.textContent = PHASE_TEXT.done;
    return;
  }
  if (progress.phase === 'fetching') {
    status.textContent =
      `${loadingLabel} ${num(progress.loaded)} / ${num(progress.total)} ` +
      `(${(progress.bytesLoaded / 1048576).toFixed(1)} MB)` +
      (progress.degraded ? ' — host ignores Range, reading whole files' : '');
    return;
  }
  status.textContent = PHASE_TEXT[progress.phase];
}

/** Builds the partial-progress callback {@link loadFrom} expects. */
function makeReporter(started: number): (patch: Partial<LoadProgress>) => void {
  return (patch) => {
    render({
      phase: 'fetching',
      loaded: 0,
      total: 0,
      bytesLoaded: 0,
      totalBytes: 0,
      elapsed: performance.now() - started,
      degraded: false,
      ...patch,
    });
  };
}

function showBoot(message?: string): void {
  const boot = qs<HTMLElement>('#boot');
  boot.classList.remove('is-hidden');
  boot.style.opacity = '';
  if (message) qs<HTMLElement>('#boot-status').textContent = message;
}

function hideBoot(): void {
  const boot = qs<HTMLElement>('#boot');
  boot.style.transition = 'opacity 240ms ease';
  boot.style.opacity = '0';
  setTimeout(() => {
    boot.classList.add('is-hidden');
  }, 260);
}

function fail(error: unknown): void {
  showBoot();
  const status = qs<HTMLElement>('#boot-status');
  const message = error instanceof Error ? error.message : String(error);
  status.className = 'boot__status boot__status--error';
  status.textContent = message;
  console.error('[clarity]', error);
}

/**
 * Replaces the running app with one backed by a different dataset.
 *
 * The minimaps are not part of the dataset drop: they ship with the app and are
 * always fetched from `public/minimaps`, so swapping telemetry needs no new
 * minimap assets.
 */
function mount(
  journeys: Journey[],
  days: string[],
  maps: MapId[],
  stats: LoadStats,
  sourceLabel: string,
): void {
  const dataset = buildDataset(journeys, days, maps);
  if (dataset.journeys.length === 0) {
    throw new Error('No parquet files could be parsed from that dataset.');
  }

  currentApp?.dispose();
  const root = qs<HTMLElement>('#app');
  root.replaceChildren();

  const app = new App(root, dataset, stats);
  currentApp = app;

  // Keep a handle for debugging from the console.
  (window as unknown as { clarity: unknown }).clarity = { app, dataset, sourceLabel };

  // The overlay only clears once the first frame is on screen, and a failure here
  // (no 2D context, canvas unsupported) must surface as a readable message rather
  // than an unhandled rejection and a blank page.
  void app.start().then(hideBoot, fail);
}

function loadDropped(files: DroppedFile[]): void {
  showBoot();
  const started = performance.now();
  loadingLabel = 'Reading dropped files…';
  qs<HTMLElement>('#boot-status').className = 'boot__status';

  void loadFrom(localSource(files), started, makeReporter(started)).then(
    (result) => {
      qs<HTMLElement>('#boot-status').textContent = `Indexing ${num(
        result.stats.totalRows,
      )} samples…`;
      mount(result.journeys, result.days, result.maps, result.stats, 'dropped files');
    },
    fail,
  );
}

function boot(): void {
  loadingLabel = PHASE_TEXT.fetching;

  void loadDataset(render).then(
    (result) => {
      qs<HTMLElement>('#boot-status').textContent = `Indexing ${num(
        result.stats.totalRows,
      )} samples…`;

      try {
        mount(result.journeys, result.days, result.maps, result.stats, 'bundled dataset');
      } catch (error) {
        fail(error);
        return;
      }

      qs<HTMLElement>('#boot-fill').style.width = '100%';
      qs<HTMLElement>('#boot-status').textContent = `Ready — ${num(
        result.stats.parsedFiles,
      )} files in ${(result.stats.loadMs / 1000).toFixed(1)}s`;
    },
    fail,
  );

  dropzoneTeardown ??= enableDropzone(document.body, {
    onFiles: loadDropped,
    onError: (message) => {
      // A bad drop must never disturb a working session, so it is only logged.
      console.warn('[clarity] drop rejected:', message);
      if (!currentApp) fail(new Error(message));
    },
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

window.addEventListener('pagehide', () => {
  dropzoneTeardown?.();
  currentApp?.dispose();
});

export { el };