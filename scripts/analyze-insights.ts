/**
 * Computes the numbers quoted in INSIGHTS.md.
 *
 *   npm run analyze
 *
 * Written as a script rather than hand-derived numbers in prose so every figure
 * in the insights can be re-checked, and so a future dataset drop can be re-run.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { MAP_LIST, MAPS } from '../src/core/maps';
import { worldToUv } from '../src/core/coordinates';
import { classifyUserId } from '../src/core/classify';
import type { MapId } from '../src/core/types';

const PLAYER_DATA = join(fileURLToPath(new URL('..', import.meta.url)), 'res', 'player_data');

/** Grid resolution for hot-zone analysis, in UV cells per axis. */
const GRID = 32;

interface Zone {
  mapId: MapId;
  gi: number;
  gj: number;
  kills: number;
  deaths: number;
  storm: number;
  loot: number;
  samples: number;
  /** Sum of world coords, so we can name the centroid of a cell. */
  sumX: number;
  sumZ: number;
}

const zones = new Map<string, Zone>();
function zoneFor(mapId: MapId, gi: number, gj: number): Zone {
  const key = `${mapId}:${gi}:${gj}`;
  let zone = zones.get(key);
  if (!zone) {
    zone = { mapId, gi, gj, kills: 0, deaths: 0, storm: 0, loot: 0, samples: 0, sumX: 0, sumZ: 0 };
    zones.set(key, zone);
  }
  return zone;
}

// ---- pass 1: read everything, accumulate zones and match composition ----

const matchMap = new Map<string, { mapId: MapId; humans: number; bots: number; rows: number }>();
const dayCounts = new Map<string, number>();
const userMap = new Map<string, Set<string>>();
let totalRows = 0;

const days = (await readdir(PLAYER_DATA, { withFileTypes: true }))
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name)
  .sort();

for (const day of days) {
  const dir = join(PLAYER_DATA, day);
  const names = (await readdir(dir)).filter((n) => !n.startsWith('.'));

  for (const name of names) {
    const rows = await parquetReadObjects({ file: await asyncBufferFromFile(join(dir, name)) });
    if (rows.length === 0) continue;
    totalRows += rows.length;
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + rows.length);

    const r0 = rows[0] as Record<string, unknown>;
    const mapId = String(r0.map_id) as MapId;
    const matchId = String(r0.match_id);
    const userId = String(r0.user_id);
    const isBot = classifyUserId(userId) === 'bot';

    let match = matchMap.get(matchId);
    if (!match) {
      match = { mapId, humans: 0, bots: 0, rows: 0 };
      matchMap.set(matchId, match);
    }
    if (isBot) match.bots++;
    else match.humans++;
    match.rows += rows.length;

    let seen = userMap.get(userId);
    if (!seen) {
      seen = new Set();
      userMap.set(userId, seen);
    }
    seen.add(matchId);

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] as Record<string, unknown>;
      const x = r.x as number;
      const z = r.z as number;
      const event = String(r.event);

      const { u, v } = worldToUv(mapId, x, z);
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;

      const gi = Math.min(GRID - 1, Math.floor(u * GRID));
      const gj = Math.min(GRID - 1, Math.floor((1 - v) * GRID));
      const zone = zoneFor(mapId, gi, gj);
      zone.samples++;
      zone.sumX += x;
      zone.sumZ += z;

      switch (event) {
        case 'Kill':
        case 'BotKill':
          zone.kills++;
          break;
        case 'Killed':
        case 'BotKilled':
          zone.deaths++;
          break;
        case 'KilledByStorm':
          zone.storm++;
          break;
        case 'Loot':
          zone.loot++;
          break;
      }
    }
  }
  process.stdout.write('.');
}
process.stdout.write('\n\n');

// ---- pass 2: kill/death symmetry, which decides whether the export can be
// treated as a scoreboard at all ----

interface Balance {
  kills: number;
  deaths: number;
  humanKills: number;
  botKills: number;
  humanDeaths: number;
  botDeaths: number;
  stormDeaths: number;
  /** Files that recorded at least one kill. */
  killerFiles: number;
  /** Files that recorded at least one death. */
  victimFiles: number;
  botFiles: number;
  humanFiles: number;
  rows: number;
}

const balances = new Map<string, Balance>();
const blankBalance = (): Balance => ({
  kills: 0,
  deaths: 0,
  humanKills: 0,
  botKills: 0,
  humanDeaths: 0,
  botDeaths: 0,
  stormDeaths: 0,
  killerFiles: 0,
  victimFiles: 0,
  botFiles: 0,
  humanFiles: 0,
  rows: 0,
});

for (const day of days) {
  for (const name of (await readdir(join(PLAYER_DATA, day))).filter((n) => !n.startsWith('.'))) {
    const rows = await parquetReadObjects({ file: await asyncBufferFromFile(join(PLAYER_DATA, day, name)) });
    if (rows.length === 0) continue;

    const r0 = rows[0] as Record<string, unknown>;
    const matchId = String(r0.match_id);
    const userId = String(r0.user_id);
    const isBot = classifyUserId(userId) === 'bot';

    const b = balances.get(matchId) ?? blankBalance();
    balances.set(matchId, b);
    b.rows += rows.length;
    if (isBot) b.botFiles++;
    else b.humanFiles++;

    let killedBy = 0;
    for (let i = 0; i < rows.length; i++) {
      const event = String((rows[i] as Record<string, unknown>).event);
      switch (event) {
        case 'Kill':
          b.kills++;
          b.humanKills++;
          break;
        case 'BotKill':
          b.kills++;
          b.botKills++;
          break;
        case 'Killed':
          b.deaths++;
          b.humanDeaths++;
          killedBy++;
          break;
        case 'BotKilled':
          b.deaths++;
          b.botDeaths++;
          killedBy++;
          break;
        case 'KilledByStorm':
          b.deaths++;
          b.stormDeaths++;
          killedBy++;
          break;
      }
    }
    if (b.kills > 0) b.killerFiles++;
    if (killedBy > 0) b.victimFiles++;
  }
  process.stdout.write('.');
}
process.stdout.write('\n\n');

// ---- report ----

console.log(`rows ${totalRows}  matches ${matchMap.size}  players ${userMap.size}\n`);

console.log('MATCH COMPOSITION');
let allHuman = 0;
let allBot = 0;
let mixed = 0;
const humanCounts: number[] = [];
const botCounts: number[] = [];
for (const m of matchMap.values()) {
  humanCounts.push(m.humans);
  botCounts.push(m.bots);
  if (m.bots === 0) allHuman++;
  else if (m.humans === 0) allBot++;
  else mixed++;
}
humanCounts.sort((a, b) => a - b);
botCounts.sort((a, b) => a - b);
const median = (a: number[]): number => a[Math.floor(a.length / 2)]!;
console.log(`  matches with no bots   : ${allHuman} (${((allHuman / matchMap.size) * 100).toFixed(1)}%)`);
console.log(`  matches with no humans : ${allBot} (${((allBot / matchMap.size) * 100).toFixed(1)}%)`);
console.log(`  mixed                  : ${mixed} (${((mixed / matchMap.size) * 100).toFixed(1)}%)`);
console.log(`  median humans per match: ${median(humanCounts)}   max ${Math.max(...humanCounts)}`);
console.log(`  median bots per match  : ${median(botCounts)}   max ${Math.max(...botCounts)}`);

const repeatMatches = [...userMap.values()].filter((s) => s.size > 1).length;
console.log(`  players in >1 match    : ${repeatMatches} of ${userMap.size}`);

console.log('\nVOLUME BY DAY (position + event samples)');
for (const day of days) console.log(`  ${day.padEnd(14)} ${dayCounts.get(day) ?? 0}`);

console.log('\nVOLUME BY MAP');
const perMapMatches = new Map<string, number>();
for (const m of matchMap.values()) perMapMatches.set(m.mapId, (perMapMatches.get(m.mapId) ?? 0) + 1);
const perMapSamples = new Map<string, number>();
let mapRows = 0;
for (const z of zones.values()) {
  perMapSamples.set(z.mapId, (perMapSamples.get(z.mapId) ?? 0) + z.samples);
  mapRows += z.samples;
}
for (const config of MAP_LIST) {
  const samples = perMapSamples.get(config.id) ?? 0;
  console.log(
    `  ${config.displayName.padEnd(16)} ${String(perMapMatches.get(config.id) ?? 0).padStart(4)} matches  ` +
      `${((samples / mapRows) * 100).toFixed(1).padStart(5)}% of samples`,
  );
}

console.log(`\nSPACE UTILISATION (${GRID}x${GRID} grid cells per map)`);
for (const config of MAP_LIST) {
  const cells = [...zones.values()].filter((z) => z.mapId === config.id);
  const occupied = cells.filter((z) => z.samples > 0).length;
  const total = GRID * GRID;
  const allSamples = cells.reduce((s, z) => s + z.samples, 0);

  // Concentration: what share of samples sit in the busiest 10% of cells.
  const sorted = [...cells].sort((a, b) => b.samples - a.samples);
  const topN = Math.max(1, Math.round(total * 0.1));
  const topShare =
    allSamples > 0 ? (sorted.slice(0, topN).reduce((s, z) => s + z.samples, 0) / allSamples) * 100 : 0;

  console.log(
    `  ${config.displayName.padEnd(16)} ${String(occupied).padStart(4)}/${total} cells touched ` +
      `(${((occupied / total) * 100).toFixed(1).padStart(5)}%), busiest 10% of map holds ${topShare.toFixed(1)}% of samples`,
  );
}

function topZones(mapId: MapId, pick: (z: Zone) => number, label: string, limit = 6): void {
  const rows = [...zones.values()]
    .filter((z) => z.mapId === mapId && pick(z) > 0)
    .sort((a, b) => pick(b) - pick(a))
    .slice(0, limit);
  if (rows.length === 0) return;
  const config = MAPS[mapId];
  console.log(`\n  ${label} (${config.displayName})`);
  for (const z of rows) {
    const cx = z.sumX / z.samples;
    const cz = z.sumZ / z.samples;
    const { u, v } = worldToUv(mapId, cx, cz);
    const ns = v > 2 / 3 ? 'north' : v < 1 / 3 ? 'south' : 'centre';
    const ew = u > 2 / 3 ? 'east' : u < 1 / 3 ? 'west' : '';
    const where = [ns, ew].filter(Boolean).join('-');
    console.log(
      `    ${String(pick(z)).padStart(5)}  uv(${u.toFixed(2)},${v.toFixed(2)})  world(${cx.toFixed(0)}, ${cz.toFixed(0)})  ${where}`,
    );
  }
}

console.log('\nHOT ZONES');
for (const config of MAP_LIST) {
  console.log(`\n${config.displayName}`);
  topZones(config.id, (z) => z.samples, 'traffic (samples)');
  topZones(config.id, (z) => z.deaths, 'deaths by players');
  topZones(config.id, (z) => z.storm, 'storm deaths');
  topZones(config.id, (z) => z.kills, 'kills');
  topZones(config.id, (z) => z.loot, 'loot pickups');
}

console.log('\nEVENT MIX');
let stormTotal = 0;
let playerDeathTotal = 0;
let killTotal = 0;
let lootTotal = 0;
for (const z of zones.values()) {
  stormTotal += z.storm;
  playerDeathTotal += z.deaths;
  killTotal += z.kills;
  lootTotal += z.loot;
}
console.log(`  kills by subject          ${killTotal}`);
console.log(`  deaths by players/bots    ${playerDeathTotal}`);
console.log(`  deaths to storm           ${stormTotal}`);
console.log(`  loot pickups              ${lootTotal}`);
console.log(`  storm share of all deaths ${((stormTotal / (stormTotal + playerDeathTotal)) * 100).toFixed(1)}%`);

console.log('\nBUSIEST CELL vs DEADLIEST CELL');
console.log('  (traffic and danger are not the same thing -- compare these directly)');
for (const config of MAP_LIST) {
  const cells = [...zones.values()].filter((z) => z.mapId === config.id && z.samples > 0);
  if (cells.length === 0) continue;

  const busiest = cells.reduce((a, b) => (b.samples > a.samples ? b : a));
  const deadliest = cells.reduce((a, b) => (b.deaths > a.deaths ? b : a));
  const lootiest = cells.reduce((a, b) => (b.loot > a.loot ? b : a));

  const label = (z: Zone): string => {
    const cx = z.sumX / z.samples;
    const cz = z.sumZ / z.samples;
    return `world(${cx.toFixed(0)}, ${cz.toFixed(0)})`;
  };

  console.log(`\n  ${config.displayName}`);
  console.log(
    `    busiest  ${String(busiest.samples).padStart(5)} samples  ${label(busiest).padEnd(18)} ` +
      `deaths=${busiest.deaths} kills=${busiest.kills} loot=${busiest.loot}`,
  );
  console.log(
    `    deadliest${String(deadliest.deaths).padStart(5)} deaths   ${label(deadliest).padEnd(18)} ` +
      `samples=${deadliest.samples} kills=${deadliest.kills} loot=${deadliest.loot}`,
  );
  console.log(
    `    lootiest ${String(lootiest.loot).padStart(5)} loot     ${label(lootiest).padEnd(18)} ` +
      `samples=${lootiest.samples} deaths=${lootiest.deaths}`,
  );
}

console.log('\nKILL / DEATH SYMMETRY');
let totalKills = 0;
let totalDeaths = 0;
let totalKillerFiles = 0;
let totalVictimFiles = 0;
let totalFiles = 0;
let botFiles = 0;
let botKillEvents = 0;
let botDeathEvents = 0;
let balancedMatches = 0;
let matchesWithCombat = 0;

for (const b of balances.values()) {
  totalKills += b.kills;
  totalDeaths += b.deaths;
  totalKillerFiles += b.killerFiles;
  totalVictimFiles += b.victimFiles;
  totalFiles += b.botFiles + b.humanFiles;
  botFiles += b.botFiles;
  botKillEvents += b.botKills;
  botDeathEvents += b.botDeaths + b.stormDeaths;
  if (b.kills > 0 || b.deaths > 0) matchesWithCombat++;
  if (b.kills === b.deaths && b.kills > 0) balancedMatches++;
}

console.log(`  kills ${totalKills}   deaths ${totalDeaths}   ratio ${(totalKills / totalDeaths).toFixed(2)}:1`);
console.log('  (every kill in a real match produces exactly one death, so ~1:1 is expected)');
console.log(`  files recording a kill    ${totalKillerFiles} of ${totalFiles}`);
console.log(`  files recording a death   ${totalVictimFiles} of ${totalFiles}`);
console.log(`  matches with any combat   ${matchesWithCombat}`);
console.log(`  matches where kills == deaths: ${balancedMatches}`);
console.log(
  `  bot files ${botFiles}: avg ${(botKillEvents / Math.max(1, botFiles)).toFixed(1)} kills and ` +
    `${(botDeathEvents / Math.max(1, botFiles)).toFixed(1)} deaths each`,
);
console.log('  -> kill and death events are NOT symmetric in this export; see INSIGHTS.md');