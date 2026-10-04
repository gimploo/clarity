/**
 * Guards the browser loader's parquet column contract against the real data.
 *
 *   npm run verify:loader
 *
 * hyparquet only decodes the columns listed in `columns`, so a restricted read
 * that omits an identity column silently produces rows with `undefined` for it.
 * That failure mode is invisible in the app until it is fatal: the loader rejects
 * every file as "unknown map_id" and the whole page errors out. Reading the files
 * without a `columns` filter, as verify-mapping.ts does, cannot catch it.
 *
 * This script therefore reads a sample of files with the *exact* column list the
 * app requests and asserts the identity fields come back populated and consistent.
 * Exits non-zero on failure so it can gate a build.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { isMapId } from '../src/core/types';
import { classifyUserId, matchIdFromFilename, userIdFromFilename } from '../src/core/classify';
import { COLUMNS, IDENTITY_COLUMNS, READ_COLUMNS } from '../src/data/schema';

const PLAYER_DATA = join(fileURLToPath(new URL('..', import.meta.url)), 'res', 'player_data');

/** Files checked per day; enough to cover every map and both subject kinds. */
const PER_DAY = 40;

console.log(`requesting columns: ${READ_COLUMNS.join(', ')}\n`);

const days = (await readdir(PLAYER_DATA, { withFileTypes: true }))
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name)
  .sort();

const errors: string[] = [];
let checked = 0;
let rows = 0;
const mapsSeen = new Set<string>();

for (const day of days) {
  const names = (await readdir(join(PLAYER_DATA, day))).filter((n) => !n.startsWith('.')).sort();
  // Evenly spread the sample across the day rather than taking a prefix, which
  // would only ever hit one map.
  const stride = Math.max(1, Math.floor(names.length / PER_DAY));
  const sample = names.filter((_, i) => i % stride === 0).slice(0, PER_DAY);

  for (const name of sample) {
    const path = join(PLAYER_DATA, day, name);
    const parsed = await parquetReadObjects({
      file: await asyncBufferFromFile(path),
      columns: [...READ_COLUMNS],
    });
    checked++;

    if (parsed.length === 0) {
      errors.push(`${name}: no rows`);
      continue;
    }
    rows += parsed.length;

    const first = parsed[0] as Record<string, unknown>;

    for (const column of READ_COLUMNS) {
      if (!(column in first)) {
        errors.push(`${name}: column "${column}" missing from restricted read`);
      }
    }

    const mapId = String(first.map_id ?? '');
    const matchId = String(first.match_id ?? '');
    const userId = String(first.user_id ?? '');

    if (!mapId) errors.push(`${name}: map_id is ${JSON.stringify(first.map_id)}`);
    else if (!isMapId(mapId)) errors.push(`${name}: map_id "${mapId}" is not a known map`);
    else mapsSeen.add(mapId);

    if (!matchId) errors.push(`${name}: match_id is ${JSON.stringify(first.match_id)}`);
    if (!userId) errors.push(`${name}: user_id is ${JSON.stringify(first.user_id)}`);

    // The filename is an independent source for the two ids, so a mismatch means
    // the rows are not what the manifest implies.
    const nameMatch = matchIdFromFilename(name);
    const nameUser = userIdFromFilename(name);
    if (nameMatch && matchId && nameMatch !== matchId) {
      errors.push(`${name}: match_id "${matchId}" disagrees with filename "${nameMatch}"`);
    }
    if (nameUser && userId && nameUser !== userId) {
      errors.push(`${name}: user_id "${userId}" disagrees with filename "${nameUser}"`);
    }

    if (classifyUserId(userId) === 'unknown') {
      errors.push(`${name}: user_id "${userId}" matches neither UUID nor numeric`);
    }

    // Every row of a file describes one subject, so identity must be constant.
    for (let i = 1; i < parsed.length; i++) {
      const row = parsed[i] as Record<string, unknown>;
      if (String(row.user_id ?? '') !== userId || String(row.match_id ?? '') !== matchId) {
        errors.push(`${name}: row ${i} has a different user_id/match_id than row 0`);
        break;
      }
    }
  }
  process.stdout.write('.');
}
process.stdout.write('\n\n');

console.log(`checked ${checked} files, ${rows} rows`);
console.log(`maps covered: ${[...mapsSeen].sort().join(', ')}`);
console.log(`identity columns verified present: ${IDENTITY_COLUMNS.join(', ')}`);

if (errors.length) {
  console.error(`\nloader contract FAILED (${errors.length} problem(s)):`);
  for (const error of errors.slice(0, 25)) console.error(`  - ${error}`);
  if (errors.length > 25) console.error(`  ...and ${errors.length - 25} more`);
  process.exit(1);
}

console.log(
  `\nloader contract verified: a restricted read of [${COLUMNS.join(', ')}] ` +
    `still yields ${IDENTITY_COLUMNS.join(', ')}`,
);