/**
 * Density heatmap overlay.
 *
 * Points are accumulated into a fixed grid in UV space, which keeps the cost
 * independent of zoom and canvas size. The grid is painted once into an
 * offscreen canvas and blitted, so panning and zooming stay cheap.
 *
 * UV is the right space to bin in because the grid then lines up with the map
 * rather than with the current viewport.
 */
import { MAPS } from '../core/maps';
import { EVENT_TYPES, isFatal, isMovement } from '../core/types';
import type { HeatmapMode, Journey } from '../core/types';
import type { Viewport } from './viewport';

const GRID = 256;

const KILL_EVENTS = new Set<number>([
  EVENT_TYPES.indexOf('Kill'),
  EVENT_TYPES.indexOf('BotKill'),
]);

/** Colour ramp stops: cold through to hot. */
const RAMP: Array<[number, readonly [number, number, number]]> = [
  [0.0, [10, 20, 60]],
  [0.15, [30, 90, 180]],
  [0.35, [20, 180, 190]],
  [0.55, [120, 210, 70]],
  [0.75, [250, 200, 40]],
  [1.0, [240, 70, 60]],
];

function rampColor(t: number): [number, number, number] {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < RAMP.length; i++) {
    const [stop, color] = RAMP[i]!;
    const [prevStop, prevColor] = RAMP[i - 1]!;
    if (clamped <= stop) {
      const span = stop - prevStop;
      const f = span === 0 ? 0 : (clamped - prevStop) / span;
      return [
        Math.round(prevColor[0] + (color[0] - prevColor[0]) * f),
        Math.round(prevColor[1] + (color[1] - prevColor[1]) * f),
        Math.round(prevColor[2] + (color[2] - prevColor[2]) * f),
      ];
    }
  }
  return [...RAMP[RAMP.length - 1]![1]] as [number, number, number];
}

export class HeatmapLayer {
  private grid = new Float32Array(GRID * GRID);
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private signature = '';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = GRID;
    this.canvas.height = GRID;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }

  /** True when the rendered grid already matches this input signature. */
  matches(signature: string): boolean {
    return this.signature === signature;
  }

  /** Rebuilds the density grid for the given journeys and mode. */
  build(journeys: Journey[], mode: HeatmapMode, signature: string): void {
    this.signature = signature;
    this.grid.fill(0);

    if (mode !== 'none' && journeys.length > 0) {
      for (const journey of journeys) {
        const { originX, originZ, scale } = MAPS[journey.mapId];
        const n = journey.x.length;

        for (let i = 0; i < n; i++) {
          const event = journey.e[i]!;
          const wanted =
            (mode === 'kills' && KILL_EVENTS.has(event)) ||
            (mode === 'deaths' && isFatal(event)) ||
            (mode === 'traffic' && isMovement(event));
          if (!wanted) continue;

          const u = (journey.x[i]! - originX) / scale;
          const v = (journey.z[i]! - originZ) / scale;
          if (u < 0 || u > 1 || v < 0 || v > 1) continue;

          this.splat(u * GRID, (1 - v) * GRID, journey.isBot);
        }
      }
    }

    this.paint();
  }

  /**
   * Adds a point with a small gaussian kernel so clusters read as areas rather
   * than as individual dots. Bot samples count slightly less so human traffic
   * stays dominant when both are shown.
   */
  private splat(gx: number, gy: number, isBot: boolean): void {
    const radius = isBot ? 1 : 2;
    const weight = isBot ? 0.55 : 1;
    const cx = Math.floor(gx);
    const cy = Math.floor(gy);
    const x0 = Math.max(0, cx - radius);
    const x1 = Math.min(GRID - 1, cx + radius);
    const y0 = Math.max(0, cy - radius);
    const y1 = Math.min(GRID - 1, cy + radius);

    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - gy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - gx;
        const falloff = Math.exp(-(dx * dx + dy * dy) / 2.2);
        this.grid[y * GRID + x] += falloff * weight;
      }
    }
  }

  /** Normalises the grid and paints it into the offscreen canvas. */
  private paint(): void {
    let max = 0;
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i]! > max) max = this.grid[i]!;
    }

    const image = this.ctx.createImageData(GRID, GRID);
    const data = image.data;

    if (max > 0) {
      // Square-root scaling: raw counts are heavily skewed, so a linear ramp
      // would show one blown-out hotspot and nothing else.
      const invMax = 1 / Math.sqrt(max);
      for (let i = 0; i < this.grid.length; i++) {
        const value = this.grid[i]!;
        if (value <= 0) continue;
        const t = Math.min(1, Math.sqrt(value) * invMax);
        const [r, g, b] = rampColor(t);
        const o = i * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = Math.round(255 * (0.15 + t * 0.85));
      }
    }

    this.ctx.putImageData(image, 0, 0);
  }

  /** Peak grid value, for the legend scale. */
  peak(): number {
    let max = 0;
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i]! > max) max = this.grid[i]!;
    }
    return max;
  }

  /** Draws the overlay over the minimap. */
  draw(ctx: CanvasRenderingContext2D, viewport: Viewport, alpha: number): void {
    if (alpha <= 0 || this.peak() <= 0) return;
    const rect = viewport.fitRect();

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      this.canvas,
      rect.x + viewport.panX,
      rect.y + viewport.panY,
      rect.w * viewport.zoom,
      rect.h * viewport.zoom,
    );
    ctx.restore();
  }
}