/**
 * Verifies the world -> minimap coordinate mapping against the real dataset.
 *
 * The map table in res/player_data/README.md gives a scale and an origin per map
 * but describes every minimap as 1024x1024, which is wrong for all three. The
 * only way to know the transform is right is to push the actual telemetry through
 * it and check that the result lands inside the unit square. A bad origin or a
 * transposed axis shows up here immediately as out-of-range UV.
 *
 *   npm run verify:mapping
 *
 * Exits non-zero if any map has coordinates outside its bounds, so this can gate
 * a build.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { isMapId, EVENT_TYPES } from '../src/core/types';
import type { MapId } from '../src/core/types';
import { MAP_LIST } from '../src/core/maps';
import { isInsideMap, worldToUv } from '../src/core/coordinates';
import { classifyUserId } from '../src/core/classify';

const PLAYER_DATA = join(fileURLToPath(new URL('..', import.meta.url)), 'res', 'player_data');

interface MapStats {
  rows: number;
  files: number;
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  outside: number;
  outsideSamples: string[];
}

function blankStats(): MapStats {
  return {
    rows: 0,
    files: 0,
    minU: Infinity,
    maxU: -Infinity,
    minV: Infinity,
    maxV: -Infinity,
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
    outside: 0,
    outsideSamples: [],
  };
}

const stats = new Map<MapId, MapStats>();
const bySubject = new Map<string, number>();
const eventTotals = new Map<string, number>();
let totalFiles = 0;
let totalRows = 0;
let unknownSubjects = 0;
let unsortedFiles = 0;
let minMatchDuration = Infinity;
let maxMatchDuration = -Infinity;
const matchSpan = new Map<string, { min: number; max: number }>();

const days = (await readdir(PLAYER_DATA, { withFileTypes: true }))
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name)
  .sort();

process.stdout.write('reading parquet');
for (const day of days) {
  const dir = join(PLAYER_DATA, day);
  for (const name of await readdir(dir)) {
    if (name.startsWith('.')) continue;
    const rows = await parquetReadObjects({ file: await asyncBufferFromFile(join(dir, name)) });
    if (rows.length === 0) continue;

    totalFiles++;
    totalRows += rows.length;

    const mapId = String(rows[0].map_id);
    if (!isMapId(mapId)) {
      console.warn(`\n  ! unknown map_id "${mapId}" in ${name}`);
      continue;
    }
    const s = stats.get(mapId) ?? blankStats();
    s.files++;

    const subject = classifyUserId(String(rows[0].user_id));
    if (subject === 'unknown') unknownSubjects++;

    let outOfOrder = false;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const x = r.x as number;
      const y = r.y as number;
      const z = r.z as number;
      const t = r.ts instanceof Date ? r.ts.getTime() : Number(r.ts);
      const event = String(r.event);

      eventTotals.set(event, (eventTotals.get(event) ?? 0) + 1);
      const key = `${subject}|${event}`;
      bySubject.set(key, (bySubject.get(key) ?? 0) + 1);

      if (i > 0) {
        const prev = rows[i - 1];
        const pt = prev.ts instanceof Date ? prev.ts.getTime() : Number(prev.ts);
        if (t < pt) outOfOrder = true;
      }

      const matchId = String(r.match_id);
      const span = matchSpan.get(matchId) ?? { min: Infinity, max: -Infinity };
      span.min = Math.min(span.min, t);
      span.max = Math.max(span.max, t);
      matchSpan.set(matchId, span);

      s.rows++;
      s.minX = Math.min(s.minX, x);
      s.maxX = Math.max(s.maxX, x);
      s.minY = Math.min(s.minY, y);
      s.maxY = Math.max(s.maxY, y);
      s.minZ = Math.min(s.minZ, z);
      s.maxZ = Math.max(s.maxZ, z);

      const { u, v } = worldToUv(mapId, x, z);
      s.minU = Math.min(s.minU, u);
      s.maxU = Math.max(s.maxU, u);
      s.minV = Math.min(s.minV, v);
      s.maxV = Math.max(s.maxV, v);

      if (!isInsideMap(u, v, 0.001)) {
        s.outside++;
        if (s.outsideSamples.length < 5) {
          s.outsideSamples.push(`u=${u.toFixed(4)} v=${v.toFixed(4)} x=${x.toFixed(1)} z=${z.toFixed(1)}`);
        }
      }
    }
    if (outOfOrder) unsortedFiles++;
    stats.set(mapId, s);
  }
  process.stdout.write('.');
}
process.stdout.write('\n\n');

console.log(`files ${totalFiles}  rows ${totalRows}  matches ${matchSpan.size}`);
console.log(`subjects: unknown user_id format = ${unknownSubjects}`);
console.log(`files with out-of-order timestamps = ${unsortedFiles} (loader sorts defensively)\n`);

console.log('coordinate mapping');
let failed = false;
for (const config of MAP_LIST) {
  const s = stats.get(config.id);
  if (!s) {
    console.log(`  ${config.displayName.padEnd(16)} no rows`);
    continue;
  }
  const inBounds = s.outside === 0;
  if (!inBounds) failed = true;
  const ok = inBounds ? 'OK  ' : 'FAIL';
  console.log(`  [${ok}] ${config.displayName.padEnd(16)} scale=${config.scale} origin=(${config.originX}, ${config.originZ})`);
  console.log(`         world x [${s.minX.toFixed(1)}, ${s.maxX.toFixed(1)}]  map spans [${config.originX}, ${config.originX + config.scale}]`);
  console.log(`         world z [${s.minZ.toFixed(1)}, ${s.maxZ.toFixed(1)}]  map spans [${config.originZ}, ${config.originZ + config.scale}]`);
  console.log(`         world y [${s.minY.toFixed(1)}, ${s.maxY.toFixed(1)}]  (elevation, unused for 2D)`);
  console.log(`         uv u [${s.minU.toFixed(4)}, ${s.maxU.toFixed(4)}]  v [${s.minV.toFixed(4)}, ${s.maxV.toFixed(4)}]  -> ${inBounds ? 'all inside unit square' : `${s.outside} rows OUTSIDE`}`);
  if (!inBounds) for (const sample of s.outsideSamples) console.log(`           ${sample}`);
  console.log(`         ${s.files} files, ${s.rows} rows`);
}

for (const { min, max } of matchSpan.values()) {
  const d = max - min;
  minMatchDuration = Math.min(minMatchDuration, d);
  maxMatchDuration = Math.max(maxMatchDuration, d);
}
console.log(`\nmatch duration (raw ts units): min ${minMatchDuration}  max ${maxMatchDuration}`);
console.log('  -> the raw timeline is sub-second per match, so playback must be time-warped');

console.log('\nevents by subject (event type alone does NOT identify the subject):');
for (const [key, count] of [...bySubject].sort()) {
  const [subject, event] = key.split('|');
  console.log(`  ${subject.padEnd(7)} ${event.padEnd(16)} ${count}`);
}

console.log('\nevent totals:');
const total = [...eventTotals.values()].reduce((a, b) => a + b, 0);
for (const event of EVENT_TYPES) {
  const count = eventTotals.get(event) ?? 0;
  const pct = ((count / total) * 100).toFixed(2).padStart(6);
  console.log(`  ${event.padEnd(16)} ${String(count).padStart(6)}  ${pct}%`);
}

if (failed) {
  console.error('\ncoordinate mapping FAILED: some rows fall outside their minimap');
  process.exit(1);
}
console.log('\ncoordinate mapping verified: every row lands inside its minimap');