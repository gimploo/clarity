/**
 * Prepares static assets for the site.
 *
 *  1. Downscales the source minimaps (up to 9000x9000) into web-friendly webp.
 *     The originals are 24.5 MB total and a 9000x9000 JPEG decodes to ~324 MB of
 *     RAM, which crashes tabs. The coordinate transform works in normalised UV
 *     space, so downscaling is lossless with respect to placement.
 *
 *  2. Writes a manifest of the parquet files so the client can show real
 *     progress and plan its fetch pool without probing the directory.
 *     This step only stats files and parses their names -- it does not read
 *     parquet. All parquet parsing happens in the browser.
 *
 * Source of truth is res/. Everything written here is generated and gitignored.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RES = join(ROOT, 'res');
const OUT_MINIMAPS = join(ROOT, 'public', 'minimaps');
const OUT_DATA = join(ROOT, 'public', 'data');
const PLAYER_DATA = join(RES, 'player_data');

/** Longest-edge target for the web minimaps. ~2x the on-screen size, retina-safe. */
const MINIMAP_MAX_EDGE = 2048;

/** Matches the user_id formats documented in res/player_data/README.md. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ManifestFile {
  /** Path relative to public/data/, POSIX separators. */
  p: string;
  /** Source day folder, e.g. "February_10". */
  d: string;
  /** Byte length, used to report total download weight up front. */
  s: number;
  /** 1 when the user_id is numeric (bot), 0 when UUID (human). From the filename. */
  b: 0 | 1;
}

export interface Manifest {
  generatedAt: string;
  totalFiles: number;
  totalBytes: number;
  days: string[];
  files: ManifestFile[];
}

async function dirSize(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? await dirSize(full) : (await stat(full)).size;
  }
  return total;
}

async function prepareMinimaps(): Promise<void> {
  await mkdir(OUT_MINIMAPS, { recursive: true });
  const src = join(RES, 'minimaps');
  const entries = (await readdir(src)).filter((f) => !f.startsWith('.'));

  console.log('minimaps:');
  for (const name of entries) {
    const input = join(src, name);
    // Lockdown_Minimap.jpg -> Lockdown_Minimap.webp
    const outName = name.replace(/\.(png|jpe?g)$/i, '.webp');
    const before = (await stat(input)).size;
    const meta = await sharp(input).metadata();

    const info = await sharp(input)
      .resize({
        width: MINIMAP_MAX_EDGE,
        height: MINIMAP_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 6 })
      .toFile(join(OUT_MINIMAPS, outName));

    const after = (await stat(join(OUT_MINIMAPS, outName))).size;
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
    console.log(
      `  ${name} ${meta.width}x${meta.height} ${mb(before)} -> ${outName} ` +
        `${info.width}x${info.height} ${mb(after)} (${((1 - after / before) * 100).toFixed(0)}% smaller)`,
    );
  }
}

async function prepareManifest(): Promise<void> {
  await mkdir(OUT_DATA, { recursive: true });

  const days = (await readdir(PLAYER_DATA, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

  const files: ManifestFile[] = [];
  for (const day of days) {
    const dayDir = join(PLAYER_DATA, day);
    const names = (await readdir(dayDir)).filter((f) => !f.startsWith('.'));
    for (const name of names) {
      const full = join(dayDir, name);
      const info = await stat(full);
      if (!info.isFile()) continue;

      // Files are named "{user_id}_{match_id}.nakama-0". The user_id is either a
      // UUID (human) or a bare integer (bot); there is no third form in the data.
      const userId = name.split('_')[0] ?? '';
      const isNumeric = /^\d+$/.test(userId);

      files.push({
        p: `${day}/${name}`.split(sep).join('/'),
        d: day,
        s: info.size,
        b: isNumeric ? 1 : 0,
      });

      if (!isNumeric && !UUID_RE.test(userId)) {
        console.warn(`  ! unrecognised user_id "${userId}" in ${name}, treating as human`);
      }
    }
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    totalFiles: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.s, 0),
    days,
    files,
  };

  // The parquet files themselves are served as-is; the site reads them in-browser.
  // Hard-link where possible so we do not double 8.4 MB in the artifact, and fall
  // back to copying on filesystems that cannot link.
  let linked = 0;
  let copied = 0;
  let skipped = 0;
  for (const day of days) {
    const dest = join(OUT_DATA, day);
    await mkdir(dest, { recursive: true });
    for (const entry of await readdir(join(PLAYER_DATA, day))) {
      if (entry.startsWith('.')) continue;
      const src = join(PLAYER_DATA, day, entry);
      const dst = join(dest, entry);

      if (existsSync(dst)) {
        skipped++;
        continue;
      }
      try {
        await link(src, dst);
        linked++;
      } catch {
        await copyFile(src, dst);
        copied++;
      }
    }
  }
  if (skipped) console.log(`           ${skipped} already staged, left untouched`);

  await writeFile(join(OUT_DATA, 'manifest.json'), JSON.stringify(manifest));
  // A stable hash of the file list lets the client cache-bust if the data changes.
  const hash = createHash('sha256')
    .update(files.map((f) => `${f.p}:${f.s}`).join('\n'))
    .digest('hex')
    .slice(0, 12);
  await writeFile(join(OUT_DATA, 'manifest.version'), hash);

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
  console.log(
    `manifest: ${manifest.totalFiles} files, ${mb(manifest.totalBytes)} ` +
      `(${linked} hard-linked, ${copied} copied), version ${hash}`,
  );
  console.log(`           dataset on disk: ${mb(await dirSize(PLAYER_DATA))}`);
  console.log(`           manifest: ${relative(ROOT, join(OUT_DATA, 'manifest.json'))}`);
}

await prepareMinimaps();
await prepareManifest();
console.log('assets ready');