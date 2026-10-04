# Clarity — LILA BLACK Player Journey Explorer

A browser-based tool for the Level Design team to answer spatial questions about
LILA BLACK telemetry: *where do players go, where do they die, where is the loot,
and is any of it contested?*

1,243 telemetry files (89,104 samples, 796 matches, 339 players, 3 maps, 5 days)
are parsed client-side from Parquet. No backend, no database — the whole dataset
is ~8 MB and is served as static files.

## Quick start

```bash
npm install
npm run dev        # prepares assets, then serves on http://localhost:5173/clarity/
```

The first load fetches and decodes all 1,243 files. Expect a few seconds on a cold
cache; repeat visits are served largely from the browser Cache API.

```bash
npm run build      # assets + loader contract check + typecheck + production build
npm run preview    # serve the built output
npm test           # unit tests
npm run verify     # typecheck, tests, loader contract, coordinate mapping
```

Deployment is automated: pushing to `master` builds and publishes to
`https://gimploo.github.io/clarity/`.

## What it does

| Capability | Notes |
| --- | --- |
| **Journey playback** | Every player's path drawn on the map, humans in cyan, bots in magenta |
| **Event markers** | Kills, deaths, storm deaths and loot pickups as distinct shapes |
| **Filtering** | By map, day, match and individual player |
| **Timeline** | Scrub or play any single match across every participant |
| **Heatmaps** | High-traffic areas, kill zones and death zones |
| **Inspect** | Hover any point for world coordinates, match-relative time and raw event name |
| **Navigate** | The view always fits the whole map; pick a single match to read it in detail |

### Reading the map

- **Cyan paths** — human journeys. **Magenta** — bots.
- **Orange cross** — a kill by the subject. **Red triangle** — the subject died.
- **Purple diamond** — the subject died to the storm. **Yellow square** — loot.
- Markers are **subject-relative**: a red triangle means *this player* died there.
  The killer's own file carries the matching orange cross at the same spot, so a
  contested fight shows both. See [INSIGHTS.md](INSIGHTS.md#insight-2) for why
  kills and deaths cannot be paired up from this data.

### Controls

| Input | Action |
| --- | --- |
| Click | Select a player |
| `Esc` | Clear selection |
| Drop a folder | Load a local dataset (see below) |

### Selecting a match

Overlaying hundreds of matches at once is unreadable, so every match starts selected
and the map is dimmed behind a prompt. Choose one match in the sidebar to dismiss
it and read that match in detail; clearing the selection brings the prompt back.

### Loading your own data

Drag a dataset folder anywhere onto the window. It should contain day directories of
`.nakama-*` parquet files, for example:

```
player_data/
  February_10/
    <userId>_<matchId>.nakama-0
  February_11/
    ...
```

The files are read locally in the browser and nothing is uploaded. Day names are
taken from the folder structure, so dropping the folder is required rather than
loose files. Minimaps always come from the deployed app.

## Project layout

```
src/core/      Domain logic: types, map geometry, coordinates, player classification
src/data/      Parquet loading (browser) and the in-memory dataset index
src/render/    Canvas scene: viewport, paths, markers, heatmap
src/ui/        Panels, timeline, tooltip, app shell, drag & drop loading
scripts/       Asset pipeline and the verification scripts
test/          Unit tests plus DOM mount, hit-testing and drag & drop tests
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for design decisions and the data
gotchas that shaped them, and [WALKTHROUGH.md](WALKTHROUGH.md) for a scripted
five-minute tour.

## Data caveats

The shipped data does not match its own README in two ways that materially change
the result, both documented in [ARCHITECTURE.md](ARCHITECTURE.md#data-gotchas):

1. Minimaps are **not** 1024x1024 — they are 4320x4320, 2160x2158 and 9000x9000.
2. Event type does **not** identify humans versus bots. `user_id` does.

The tool follows the data, not the README, and `npm run verify` fails the build if
either assumption regresses.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run prepare:assets` | Downscale minimaps to WebP, stage parquet files, write `public/data/manifest.json` |
| `npm run verify:mapping` | Push all 89,104 rows through the coordinate transform; fail if any lands off the minimap |
| `npm run verify:loader` | Assert the browser's restricted Parquet read still returns identity columns |
| `npm test` | Coordinate, viewport, hit-testing, DOM mount/playback and drag & drop tests |
| `npm run analyze` | Recompute every figure quoted in [INSIGHTS.md](INSIGHTS.md) |
| `npm run verify` | Typecheck, tests, loader contract and coordinate mapping |