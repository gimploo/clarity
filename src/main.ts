/**
 * Bootstrap: load the telemetry, then mount the UI.
 *
 * Loading is slow on a cold cache (over a thousand parquet files), so the boot
 * screen reports real progress rather than showing an indeterminate spinner.
 */
import './styles.css';
import { loadDataset } from './data/loader';
import type { LoadProgress } from './data/loader';
import { buildDataset } from './data/dataset';
import { App } from './ui/app';
import { el, num, qs } from './ui/dom';

const PHASE_TEXT: Record<LoadProgress['phase'], string> = {
  manifest: 'Reading manifest…',
  probing: 'Checking range-request support…',
  fetching: 'Loading telemetry…',
  indexing: 'Building index…',
  done: 'Ready',
  failed: 'Failed',
};

function boot(): void {
  const fill = qs<HTMLElement>('#boot-fill');
  const status = qs<HTMLElement>('#boot-status');

  const report = (progress: LoadProgress): void => {
    const fraction = progress.total > 0 ? progress.loaded / progress.total : 0;
    fill.style.width = `${Math.round(fraction * 100)}%`;

    if (progress.phase === 'done') {
      status.textContent = PHASE_TEXT.done;
      return;
    }
    if (progress.phase === 'fetching') {
      status.textContent =
        `${PHASE_TEXT.fetching} ${num(progress.loaded)} / ${num(progress.total)} ` +
        `(${(progress.bytesLoaded / 1048576).toFixed(1)} MB)` +
        (progress.degraded ? ' — host ignores Range, reading whole files' : '');
      return;
    }
    status.textContent = PHASE_TEXT[progress.phase];
  };

  const fail = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    status.className = 'boot__status boot__status--error';
    status.textContent = message;
    console.error('[clarity]', error);
  };

  void loadDataset(report)
    .then((result) => {
      status.textContent = `Indexing ${num(result.stats.totalRows)} samples…`;

      const dataset = buildDataset(result.journeys, result.days, result.maps);

      if (dataset.journeys.length === 0) {
        fail(
          new Error(
            'No parquet files could be parsed. Run "npm run prepare:assets" and reload.',
          ),
        );
        return;
      }

      const root = qs<HTMLElement>('#app');
      const app = new App(root, dataset, result.stats);

      // Keep a handle for debugging from the console.
      (window as unknown as { clarity: unknown }).clarity = { app, dataset, result };

      fill.style.width = '100%';
      status.textContent = `Ready — ${num(result.stats.parsedFiles)} files in ${(
        result.stats.loadMs / 1000
      ).toFixed(1)}s`;

      // The boot overlay is only removed once the first frame is on screen, and a
      // failure here (no 2D context, canvas unsupported) must surface as a
      // readable message rather than an unhandled rejection and a blank page.
      void app
        .start()
        .then(() => {
          const overlay = qs<HTMLElement>('#boot');
          overlay.style.transition = 'opacity 240ms ease';
          overlay.style.opacity = '0';
          setTimeout(() => overlay.remove(), 260);
        })
        .catch(fail);
    })
    .catch(fail);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export { el };