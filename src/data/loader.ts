/**
 * Loads the parquet telemetry in the browser.
 *
 * There are 1,243 parquet files totalling ~8 MB. Rather than one request each we
 * lean on HTTP range requests: hyparquet reads only the footer and the column
 * chunks it needs. Two details make that work here:
 *
 *  - The manifest carries each file's byte length, so we can pass `byteLength`
 *    and skip hyparquet's per-file HEAD probe. That probe would otherwise double
 *    the request count.
 *  - Range support is verified once at startup. If the host answers `200`
 *    instead of `206`, a ranged slice returns the wrong bytes and hyparquet would
 *    silently decode garbage, so we fall back to reading whole files.
 *
 * Fetched ranges are stored in the Cache API so repeat visits skip the network.
 */
import { parquetReadObjects, type AsyncBuffer, type ParquetRow } from 'hyparquet';
import { eventIndex, isMapId } from '../core/types';
import type { Journey, MapId } from '../core/types';
import { classifyUserId } from '../core/classify';
import { READ_COLUMNS } from './schema';

/**
 * Columns to read.
 *
 * Identity columns have to be requested explicitly: hyparquet only decodes the
 * columns we ask for, and the manifest does not carry `map_id`/`match_id`/
 * `user_id`. See src/data/schema.ts, which is shared with the verifier that
 * guards this contract.
 */
const COLUMNS = READ_COLUMNS;

const CACHE_NAME = 'clarity-parquet-v1';

/** Concurrency for the parquet fetch pool. HTTP/2 multiplexes these well. */
const FETCH_CONCURRENCY = 24;

export interface ManifestFile {
  p: string;
  d: string;
  s: number;
  b: 0 | 1;
}

export interface Manifest {
  generatedAt: string;
  totalFiles: number;
  totalBytes: number;
  days: string[];
  files: ManifestFile[];
}

export type LoadPhase =
  | 'manifest'
  | 'probing'
  | 'fetching'
  | 'indexing'
  | 'done'
  | 'failed';

export interface LoadProgress {
  phase: LoadPhase;
  loaded: number;
  total: number;
  bytesLoaded: number;
  totalBytes: number;
  /** Wall-clock ms since the load started. */
  elapsed: number;
  /** True when the host does not honour Range and we read whole files. */
  degraded: boolean;
  error?: string;
}

export interface LoadStats {
  totalFiles: number;
  parsedFiles: number;
  failedFiles: number;
  totalRows: number;
  bytes: number;
  degraded: boolean;
  loadMs: number;
}

export interface LoadResult {
  journeys: Journey[];
  days: string[];
  maps: MapId[];
  stats: LoadStats;
}

/** Resolves a path against the deployment base so it works under /clarity/. */
export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base}${path}`.replace(/([^:])\/{2,}/g, '$1/');
}

function canUseCacheApi(): boolean {
  return typeof caches !== 'undefined' && typeof Response !== 'undefined';
}

/**
 * Cache key for a byte range.
 *
 * The fragment is *not* usable here: the Cache API's cache-key algorithm builds
 * the key from scheme/host/path/query and discards the fragment, so `#0-100` and
 * `#100-200` would collide into a single entry and every range request after the
 * first would be served the wrong bytes. A synthetic query parameter is part of
 * the key and keeps ranges distinct.
 *
 * The key is only ever used for `cache.put`/`cache.match`, never fetched, so the
 * extra parameter cannot affect the actual request.
 */
function rangeKey(url: string, start: number, last: number): string {
  return `${url}?__range=${start}-${last}`;
}

/**
 * An AsyncBuffer that serves slices from the Cache API when available.
 *
 * When `ranged` is false the host ignored our Range probe, so we download each
 * file exactly once and slice it in memory instead of re-downloading per range.
 */
function makeBuffer(
  url: string,
  byteLength: number,
  options: { cache: boolean; ranged: boolean },
): AsyncBuffer {
  const cachePromise = options.cache ? caches.open(CACHE_NAME) : Promise.resolve(null);
  let wholeFile: Promise<ArrayBuffer> | null = null;

  const getWholeFile = (): Promise<ArrayBuffer> => {
    wholeFile ??= fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} for ${url}`);
      }
      return response.arrayBuffer();
    });
    return wholeFile;
  };

  const remember = async (cache: Cache | null, key: string, buffer: ArrayBuffer) => {
    if (!cache) return;
    // Wrap in a fresh 200 Response: Cache.put rejects 206 responses, and the
    // slice is meaningless outside this key anyway.
    await cache.put(key, new Response(buffer)).catch(() => undefined);
  };

  return {
    byteLength,
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const last = end ?? byteLength;
      const cache = await cachePromise;
      const key = rangeKey(url, start, last);

      if (cache) {
        const hit = await cache.match(key);
        if (hit) return hit.arrayBuffer();
      }

      if (!options.ranged) {
        const whole = await getWholeFile();
        return whole.slice(start, last);
      }

      const response = await fetch(url, { headers: { Range: `bytes=${start}-${last - 1}` } });

      if (response.status === 206) {
        const buffer = await response.arrayBuffer();
        await remember(cache, key, buffer);
        return buffer;
      }

      // Host sent the whole file instead of the requested range.
      const whole = await getWholeFile();
      const slice = whole.slice(start, last);
      await remember(cache, key, slice);
      return slice;
    },
  };
}

/** Runs `worker` over `items` with a bounded number in flight. */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}

async function fetchManifest(): Promise<Manifest> {
  const response = await fetch(assetUrl('data/manifest.json'));
  if (!response.ok) {
    throw new Error(
      `Could not load data/manifest.json (HTTP ${response.status}). ` +
        `Run "npm run prepare:assets" before serving the app.`,
    );
  }
  return (await response.json()) as Manifest;
}

/** Confirms the host answers ranged requests with 206. */
async function probeRangeSupport(sample: ManifestFile): Promise<boolean> {
  try {
    const response = await fetch(assetUrl(`data/${sample.p}`), {
      headers: { Range: 'bytes=0-0' },
    });
    // Drain the body so the connection can be reused.
    await response.arrayBuffer();
    return response.status === 206;
  } catch {
    return false;
  }
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'bigint') return Number(value);
  return Number(value);
}

/**
 * Parses one parquet file into a column-wise Journey.
 *
 * Rows are sorted by timestamp: three of the 1,243 files contain a single
 * out-of-order pair, and drawing an unsorted polyline produces a visible
 * zig-zag artefact.
 */
function toJourney(rows: ParquetRow[], file: ManifestFile): Journey | { reason: string } {
  if (rows.length === 0) return { reason: 'empty file' };

  const first = rows[0] as Record<string, unknown>;
  const mapId = String(first.map_id ?? '');
  const matchId = String(first.match_id ?? '');
  const userId = String(first.user_id ?? '');

  if (!isMapId(mapId)) return { reason: `unknown map_id "${mapId}"` };

  const n = rows.length;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const t = new Float64Array(n);
  const e = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const row = rows[i] as Record<string, unknown>;
    x[i] = Number(row.x);
    y[i] = Number(row.y);
    z[i] = Number(row.z);
    t[i] = toMillis(row.ts);
    const idx = eventIndex(String(row.event));
    // Unknown event names fall back to the movement bucket so they still draw.
    e[i] = idx === -1 ? 0 : idx;
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => t[a]! - t[b]!);

  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  const sz = new Float32Array(n);
  const st = new Float64Array(n);
  const se = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const src = order[i]!;
    sx[i] = x[src]!;
    sy[i] = y[src]!;
    sz[i] = z[src]!;
    st[i] = t[src]!;
    se[i] = e[src]!;
  }

  return {
    userId,
    matchId,
    mapId,
    isBot: classifyUserId(userId) === 'bot',
    day: file.d,
    source: file.p,
    t0: st[0] ?? 0,
    t1: st[n - 1] ?? 0,
    x: sx,
    y: sy,
    z: sz,
    t: st,
    e: se,
  };
}

/**
 * Loads every journey in the dataset.
 *
 * `onProgress` drives the progress bar: a cold load touches over a thousand
 * files and would otherwise look like a hang.
 */
export async function loadDataset(
  onProgress: (progress: LoadProgress) => void,
): Promise<LoadResult> {
  const started = performance.now();
  const useCache = canUseCacheApi();

  const report = (patch: Partial<LoadProgress>): void => {
    onProgress({
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

  report({ phase: 'manifest' });
  const manifest = await fetchManifest();

  const sample = manifest.files[0];
  let ranged = false;
  if (sample) {
    report({
      phase: 'probing',
      total: manifest.totalFiles,
      totalBytes: manifest.totalBytes,
    });
    ranged = await probeRangeSupport(sample);
  }

  let loaded = 0;
  let bytesLoaded = 0;
  let failed = 0;
  const failures: string[] = [];

  const parsed = await pool(manifest.files, FETCH_CONCURRENCY, async (file) => {
    const buffer = makeBuffer(assetUrl(`data/${file.p}`), file.s, { cache: useCache, ranged });
    const rows = await parquetReadObjects({ file: buffer, columns: [...COLUMNS] });
    loaded++;
    bytesLoaded += file.s;
    report({ loaded, bytesLoaded, degraded: !ranged });
    return toJourney(rows, file);
  });

  const journeys: Journey[] = [];
  for (const result of parsed) {
    if ('reason' in result) {
      failed++;
      if (failures.length < 5) failures.push(result.reason);
    } else {
      journeys.push(result);
    }
  }

  report({ phase: 'indexing', loaded, bytesLoaded, degraded: !ranged });

  if (failures.length) {
    console.warn(`[clarity] skipped ${failed} parquet file(s):`, failures);
  }

  const maps = [...new Set(journeys.map((j) => j.mapId))].sort();

  report({ phase: 'done', loaded, bytesLoaded, degraded: !ranged });

  return {
    journeys,
    days: manifest.days,
    maps,
    stats: {
      totalFiles: manifest.totalFiles,
      parsedFiles: journeys.length,
      failedFiles: failed,
      totalRows: journeys.reduce((sum, j) => sum + j.x.length, 0),
      bytes: bytesLoaded,
      degraded: !ranged,
      loadMs: performance.now() - started,
    },
  };
}