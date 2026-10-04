/**
 * Canvas scene: minimap, heatmap, player paths and event markers.
 *
 * Deliberately a single canvas with a fixed layer order rather than stacked
 * elements. With up to ~61k visible points on one map, one canvas avoids DOM
 * churn and keeps redraws at interactive rates.
 *
 *   1. minimap image   (letterboxed to the map aspect)
 *   2. heatmap overlay
 *   3. player paths
 *   4. event markers
 *   5. player heads / selection
 */
import { MAPS } from '../core/maps';
import { EVENT_TYPES, isMovement, markerKindFor } from '../core/types';
import type { Journey, MapId, MarkerKind } from '../core/types';
import { HeatmapLayer } from './heatmap';
import { MARKER_STYLES, PALETTE, drawMarker } from './styles';
import type { MarkerShape } from './styles';
import { Viewport } from './viewport';

export interface SceneInput {
  mapId: MapId;
  journeys: Journey[];
  showHumans: boolean;
  showBots: boolean;
  showKills: boolean;
  showDeaths: boolean;
  showLoot: boolean;
  showStormDeaths: boolean;
  heatmap: HeatmapLayer;
  heatmapAlpha: number;
  showPathsWithHeatmap: boolean;
  /** Playhead in match-relative ms. When null, the whole journey is drawn. */
  cursor: number | null;
}

export interface HoverTarget {
  journey: Journey;
  index: number;
  kind: MarkerKind | 'position';
  worldX: number;
  worldZ: number;
  /** Match-relative time in ms. */
  t: number;
}

const MARKER_VISIBLE: Record<MarkerKind, keyof SceneInput> = {
  kill: 'showKills',
  death: 'showDeaths',
  stormDeath: 'showStormDeaths',
  loot: 'showLoot',
};

/**
 * Event marker paint order, back to front.
 *
 * Loot is far denser than combat, so it goes down first and the rare, important
 * markers survive on top. {@link Scene.drawMarkers} and {@link Scene.pick} both
 * read this list: the marker painted last is the only one the user can actually
 * see, so it is the only correct thing for a tooltip to describe.
 */
const MARKER_PAINT_ORDER: readonly MarkerKind[] = ['loot', 'kill', 'death', 'stormDeath'];

/**
 * Pick priority per kind. Positions score lowest because movement is drawn as a
 * path beneath every marker.
 */
const KIND_PRIORITY: Record<MarkerKind | 'position', number> = (() => {
  const priority = { position: 0 } as Record<MarkerKind | 'position', number>;
  MARKER_PAINT_ORDER.forEach((kind, index) => {
    priority[kind] = index + 1;
  });
  return priority;
})();

/** Extra grab area around a marker, in CSS pixels, on top of its drawn size. */
const MARKER_GRAB_PADDING = 3;

/**
 * Per-kind hit radius in CSS pixels, derived from what is actually drawn.
 *
 * Using one flat radius for every kind meant a 3.5px loot square was hoverable
 * from 10px away — roughly three times its visible size — while the cursor read
 * as being over nothing.
 */
const HIT_RADIUS_PX: Record<MarkerKind | 'position', number> = {
  loot: MARKER_STYLES.loot.size + MARKER_GRAB_PADDING,
  kill: MARKER_STYLES.kill.size + MARKER_GRAB_PADDING,
  death: MARKER_STYLES.death.size + MARKER_GRAB_PADDING,
  stormDeath: MARKER_STYLES.stormDeath.size + MARKER_GRAB_PADDING,
  // Movement has no marker of its own; this is a pure tolerance for finding the
  // nearest subject along a path.
  position: 10,
};

export class Scene {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly viewport = new Viewport();
  private readonly images = new Map<MapId, HTMLImageElement>();
  private ready = new Map<MapId, boolean>();
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }

  get view(): Viewport {
    return this.viewport;
  }

  /** Preloads the minimap for a map. Resolves once the image is decodable. */
  loadMinimap(mapId: MapId, url: string): Promise<void> {
    const existing = this.images.get(mapId);
    if (existing?.complete) return Promise.resolve();

    return new Promise((resolve) => {
      const image = this.images.get(mapId) ?? new Image();
      image.decoding = 'async';
      const onReady = () => {
        this.ready.set(mapId, true);
        resolve();
      };
      image.addEventListener('load', onReady, { once: true });
      image.addEventListener('error', onReady, { once: true });
      if (!existing) {
        this.images.set(mapId, image);
        image.src = url;
      }
    });
  }

  hasMinimap(mapId: MapId): boolean {
    return this.ready.get(mapId) === true;
  }

  /**
   * Syncs the backing store to the element's CSS size and device pixel ratio.
   * Returns true when the size actually changed.
   */
  resize(mapId: MapId): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(rect.width));
    const cssHeight = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const config = MAPS[mapId];

    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);
    const changed = this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight;

    if (changed) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.dpr = dpr;
    this.viewport.resize(cssWidth, cssHeight, config.sourceWidth / config.sourceHeight);
    return changed;
  }

  /** Converts a mouse event to UV coordinates. */
  pointerToUv(event: { clientX: number; clientY: number }): { u: number; v: number } {
    const rect = this.canvas.getBoundingClientRect();
    return this.viewport.unproject(event.clientX - rect.left, event.clientY - rect.top);
  }

  render(input: SceneInput): void {
    const { ctx, viewport } = this;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    this.drawMinimap(input.mapId);
    input.heatmap.draw(ctx, viewport, input.heatmapAlpha);

    ctx.save();
    ctx.beginPath();
    const fit = viewport.fitRect();
    ctx.rect(fit.x, fit.y, fit.w, fit.h);
    ctx.clip();

    if (input.heatmap.mode() === 'none' || input.showPathsWithHeatmap) {
      this.drawPaths(input);
    }
    this.drawMarkers(input);
    ctx.restore();

    // Outside the clip: a head sitting on the map edge should stay visible rather
    // than being sliced in half. The border goes on top so heads read as being
    // under the map frame.
    this.drawHeads(input);
    this.drawBorder();
  }

  /**
   * Current position of each visible journey at the playhead.
   *
   * Only meaningful during playback, so it is skipped in the static view where
   * every path is drawn end-to-end and a head would just duplicate its endpoint.
   */
  private drawHeads(input: SceneInput): void {
    if (input.cursor === null) return;
    const { ctx, viewport } = this;

    for (const head of this.heads(input)) {
      const point = viewport.project(head.u, head.v);
      const isSelected = null === head.journey.userId;
      const radius = isSelected ? 6 : 4;

      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = head.journey.isBot ? PALETTE.bot : PALETTE.human;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(2, 6, 23, 0.85)';
      ctx.stroke();

      if (isSelected) {
        // A subtle ring makes the tracked player findable in a dense match.
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius + 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  private drawMinimap(mapId: MapId): void {
    const { ctx, viewport } = this;
    const image = this.images.get(mapId);
    const rect = viewport.fitRect();
    const x = rect.x;
    const y = rect.y;
    const w = rect.w;
    const h = rect.h;

    if (!image || !image.complete || image.naturalWidth === 0) {
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = PALETTE.textDim;
      ctx.font = '13px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('minimap unavailable', x + w / 2, y + h / 2);
      return;
    }

    // Darken slightly so overlay colours stay readable on bright terrain.
    ctx.save();
    ctx.filter = 'brightness(0.72) saturate(0.9)';
    ctx.drawImage(image, x, y, w, h);
    ctx.restore();
  }

  private drawPaths(input: SceneInput): void {
    const { ctx, viewport } = this;
    const config = MAPS[input.mapId];
    const cursor = input.cursor;

    // Bots first so human paths sit on top when both are visible.
    const ordered = input.journeys.slice().sort((a, b) => Number(a.isBot) - Number(b.isBot));

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const journey of ordered) {
      if (journey.isBot && !input.showBots) continue;
      if (!journey.isBot && !input.showHumans) continue;

      const isSelected = null === journey.userId;
      const end = cursor === null ? journey.x.length : upperBound(journey.t, cursor);

      if (end < 2) continue;

      ctx.beginPath();
      let started = false;
      for (let i = 0; i < end; i++) {
        // Only draw the movement polyline; marker rows would spike the line.
        if (!isMovement(journey.e[i]!)) continue;
        const u = (journey.x[i]! - config.originX) / config.scale;
        const v = (journey.z[i]! - config.originZ) / config.scale;
        const point = viewport.project(u, v);
        if (!started) {
          ctx.moveTo(point.x, point.y);
          started = true;
        } else {
          ctx.lineTo(point.x, point.y);
        }
      }

      if (!started) continue;

      ctx.strokeStyle = isSelected
        ? '#ffffff'
        : journey.isBot
          ? PALETTE.botPath
          : PALETTE.humanPath;
      ctx.lineWidth = isSelected ? 2.4 : journey.isBot ? 1 : 1.3;
      ctx.globalAlpha = isSelected ? 1 : 0.75;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawMarkers(input: SceneInput): void {
    const { ctx, viewport } = this;
    const config = MAPS[input.mapId];

    for (const kind of MARKER_PAINT_ORDER) {
      if (!input[MARKER_VISIBLE[kind]]) continue;
      const style = MARKER_STYLES[kind];
      const shape: MarkerShape = style.shape;

      for (const journey of input.journeys) {
        if (journey.isBot && !input.showBots) continue;
        if (!journey.isBot && !input.showHumans) continue;

        const n = journey.x.length;
        for (let i = 0; i < n; i++) {
          if (markerKindFor(journey.e[i]!) !== kind) continue;
          if (input.cursor !== null && journey.t[i]! > input.cursor) continue;

          const u = (journey.x[i]! - config.originX) / config.scale;
          const v = (journey.z[i]! - config.originZ) / config.scale;
          const point = viewport.project(u, v);
          drawMarker(ctx, shape, point.x, point.y, style.size, style.color);
        }
      }
    }
  }

  /** Thin frame around the map so the play area is obvious against the page. */
  private drawBorder(): void {
    const { ctx, viewport } = this;
    const rect = viewport.fitRect();
    ctx.save();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
    ctx.restore();
  }

  /** Current position of every visible journey at the playhead. */
  heads(input: SceneInput): Array<{ journey: Journey; u: number; v: number }> {
    const config = MAPS[input.mapId];
    const out: Array<{ journey: Journey; u: number; v: number }> = [];

    for (const journey of input.journeys) {
      if (journey.isBot && !input.showBots) continue;
      if (!journey.isBot && !input.showHumans) continue;

      let index = journey.x.length - 1;
      if (input.cursor !== null) {
        index = Math.min(upperBound(journey.t, input.cursor), journey.x.length - 1);
      }
      if (index < 0) continue;

      out.push({
        journey,
        u: (journey.x[index]! - config.originX) / config.scale,
        v: (journey.z[index]! - config.originZ) / config.scale,
      });
    }
    return out;
  }

  /**
   * Finds the visible marker a cursor is actually pointing at.
   *
   * Runs on every pointermove over up to ~61k samples, so it deliberately does
   * no allocation and no canvas work: candidates are rejected by comparing
   * squared distance and only the single winning hit is materialised.
   * Transforming every point to pixels first would allocate 61k objects per mouse
   * move and drop frames.
   *
   * Selection follows paint order, not raw proximity. Two things were wrong with
   * a pure nearest-match:
   *
   *  - It ignored {@link MARKER_PAINT_ORDER}, so a loot square painted *under* a
   *    death triangle could win. The tooltip then described a marker that was
   *    completely hidden.
   *  - It broke ties towards the first journey, while painting makes the last one
   *    sit on top.
   *
   * Now the topmost marker containing the cursor wins, and distance only decides
   * between candidates of the same kind, which are visually identical anyway.
   *
   * `radiusScale` widens every per-kind radius at once, which is how click
   * selection stays more forgiving than hover without inventing a second table.
   */
  pick(input: SceneInput, clientX: number, clientY: number, radiusScale = 1): HoverTarget | null {
    const canvasRect = this.canvas.getBoundingClientRect();
    const mouse = this.viewport.unproject(clientX - canvasRect.left, clientY - canvasRect.top);
    const config = MAPS[input.mapId];
    const rect = this.viewport.fitRect();

    let bestJourney: Journey | null = null;
    let bestIndex = -1;
    let bestKind: MarkerKind | 'position' = 'position';
    let bestPriority = -1;
    let bestDistance = Infinity;

    for (const journey of input.journeys) {
      if (journey.isBot && !input.showBots) continue;
      if (!journey.isBot && !input.showHumans) continue;

      const n = journey.x.length;
      for (let i = 0; i < n; i++) {
        const markerKind = markerKindFor(journey.e[i]!);
        let kind: MarkerKind | 'position';
        if (markerKind) {
          if (!input[MARKER_VISIBLE[markerKind]]) continue;
          kind = markerKind;
        } else if (input.cursor !== null) {
          // Movement samples are only hoverable in the static view, where the
          // whole path is drawn.
          continue;
        } else {
          kind = 'position';
        }

        // Distance is measured in CSS pixels rather than UV so the grab area is
        // a true circle regardless of the map's aspect ratio.
        const du = (journey.x[i]! - config.originX) / config.scale - mouse.u;
        const dv = (journey.z[i]! - config.originZ) / config.scale - mouse.v;
        const dx = du * rect.w;
        const dy = dv * rect.h;
        const radius = HIT_RADIUS_PX[kind] * radiusScale;
        const distance = dx * dx + dy * dy;
        if (distance > radius * radius) continue;

        const priority = KIND_PRIORITY[kind];
        // `<=` on the distance so that an exact tie falls to the candidate visited
        // last, which is the one painted on top. Iteration order here is journeys
        // outer and samples inner, matching drawMarkers.
        const better =
          priority > bestPriority || (priority === bestPriority && distance <= bestDistance);
        if (!better) continue;

        bestPriority = priority;
        bestDistance = distance;
        bestJourney = journey;
        bestIndex = i;
        bestKind = kind;
      }
    }

    if (!bestJourney || bestIndex < 0) return null;

    return {
      journey: bestJourney,
      index: bestIndex,
      kind: bestKind,
      worldX: bestJourney.x[bestIndex]!,
      worldZ: bestJourney.z[bestIndex]!,
      t: bestJourney.t[bestIndex]!,
    };
  }
}

/** Index of the first element strictly greater than `value` in a sorted array. */
function upperBound(array: Float64Array, value: number): number {
  let low = 0;
  let high = array.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (array[mid]! <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

export { EVENT_TYPES };