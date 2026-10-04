# Architecture

## Shape of the system

```
                    build time                        run time
                    ----------                        ---------
 res/player_data  ──┐                            ┌──▶ Cache API
 (parquet)          ├──▶ prepare:assets ──▶ public/data/
                    │      (hard links +              │
 res/minimaps    ───┘      manifest.json)            ▼
                    │                            ┌──────────┐
                    └──▶ sharp ──▶ public/       │ loader   │  hyparquet
                         minimaps/*.webp          │ (ranges) │  1,243 files
                                                 └────┬─────┘
                                                      ▼
 src/core/  types · maps · coordinates · classify   (pure, no I/O)
                                                      │
                                                 ┌────▼─────┐
                                                 │ dataset  │  rebase, index, filter
                                                 └────┬─────┘
                                                      │
 src/render/ viewport · scene · heatmap   ◀──────────┘
 src/ui/     store · sidebar · timeline · tooltip
```

Four rules keep this honest:

1. **`src/core` is pure.** No DOM, no fetch, no `import.meta`. Everything in it is
   unit-testable in Node, which is why `verify-mapping` and `verify-loader` can
   import it directly.
2. **UV is the only shared coordinate space.** Nothing outside the render layer
   knows about pixels.
3. **One-way state flow.** UI writes to the store, the store broadcasts, the app
   repaints. No panel reads another panel's DOM.
4. **The dataset is verified, not trusted.** Every non-obvious claim about the data
   has a script that fails loudly if it stops being true.

## Decisions and why

### Coordinates: normalise to UV, never to pixels

The map table in the data README gives a `scale` and `origin` per map but describes
every minimap as 1024x1024. All three are wrong — they are 4320x4320,
2160x2158 and 9000x9000. Trusting the README would place Ambrose Valley inside
the top-left quarter of its image and Lockdown almost entirely off-canvas.

So the transform is two-stage, and the intermediate is a normalised coordinate:

```
u = (x - originX) / scale        world → UV
v = (z - originZ) / scale
px = u · width                   UV → pixels, whatever width is
py = (1 - v) · height
```

`y` is elevation, not a planar map coordinate, so it is deliberately excluded —
folding it in would shear every path.

The payoff is that the same numbers work for the 4320px source, the 2048px WebP
asset, a HiDPI backing store, and any zoom level. Verified: all 89,104 rows land
inside the unit square for their map (`npm run verify:mapping`).

### Humans vs bots: classify by `user_id`, not by event type

The data README implies humans emit `Position` and bots emit `BotPosition`. That
is wrong — 636 `Position` events and 115 `Loot` events sit inside **bot** files.

`user_id` is the only signal that holds: a UUID means human, a bare integer means
bot. All 1,243 files classify cleanly with no exceptions. Event type reflects what
the telemetry happened to label, not who the subject is.

### Events are subject-relative

A `BotKilled` row in a human's file means *that human* was killed by a bot. Reading
events as global match state would mislabel roughly 30% of combat, so
`markerKindFor` and `interpretEvent` always interpret from the subject's point of
view and the legend says so explicitly.

### Parquet in the browser, via range requests

1,243 files at ~6 KB each is either a lot of requests or no problem at all,
depending on whether the host honours `Range`. hyparquet reads only the footer and
the column chunks it needs, so the fast path transfers a fraction of the bytes.

Two details make this safe:

- **The manifest carries each file's byte length**, so `byteLength` is passed
  straight to hyparquet and its per-file `HEAD` probe is skipped — that probe would
  otherwise double the request count.
- **Range support is probed once at startup.** If a host answers `200` instead of
  `206`, a ranged slice returns the wrong bytes and hyparquet would *silently
  decode garbage*. On failure the loader switches to whole-file reads and slices in
  memory. The UI surfaces this ("whole files" in the header) because it changes the
  load profile substantially.

#### The column contract

hyparquet only decodes the columns listed in `columns`. The manifest does not carry
`map_id`, `match_id` or `user_id` — only path, day, byte length and bot flag — so
those columns **must** be requested explicitly.

Omitting them is not a partial failure. Every row arrives with `map_id` undefined,
every file fails the `isMapId` check, and the app rejects the entire dataset with
"unknown map_id". `verify-mapping` cannot catch this because it reads *all*
columns; `scripts/verify-loader.ts` exists specifically to assert the restricted
read still returns populated identity fields, and it runs in `npm run build`.

The column list lives in `src/data/schema.ts` rather than in the loader because the
loader reads `import.meta.env`, which only exists under Vite. Sharing the
definition means the guard can never drift from what the app actually requests.

#### Cache API keys cannot use fragments

Fetched ranges are cached for repeat visits. The Cache API's cache-key algorithm
builds a key from scheme, host, path and query — **and discards the fragment**. A
`${url}#0-100` key therefore collides with `${url}#100-200`, and after the first
range is cached every subsequent request for that file returns the wrong bytes.

The loader keys ranges with a synthetic query parameter (`?__range=start-end`)
instead, which is part of the key. It is only ever used for `cache.put`/`match`,
never fetched, so it cannot affect the real request.

### Timestamps: rebase per match, then time-warp playback

Raw `ts` values sit around 1.77e9 with an arbitrary per-file offset, so absolute
values are meaningless across matches. Every journey in a match is rebased onto
that match's earliest timestamp, which makes per-match duration correct and lets a
single playhead drive all participants.

After rebasing, a whole match spans **13–890 ms**. A literal 1x replay is over
before it registers, so the playback control is expressed as *how long a full
replay should take* (2–30s) rather than a speed multiplier. This is both more
honest and more usable: "0.05x" means nothing to a Level Designer, "watch this
match over 8 seconds" does.

Three of the 1,243 files contain a single out-of-order timestamp pair, so rows are
sorted on load — an unsorted polyline draws a visible zig-zag.

### One canvas, fixed layer order

With ~61k visible points on the busiest map, a single canvas beats stacked DOM or
SVG elements: no node churn, and pan/zoom stay interactive. Layer order is
minimap → heatmap → paths → markers → heads → border.

Ordering within the layers is deliberate:

- Bots draw before humans so human paths stay readable when both are visible.
- Loot draws before combat markers because there are 12,885 loot events against
  742 deaths; drawing the rare markers last keeps them visible.
- Only movement samples become polyline vertices. Feeding marker rows into the
  line would spike it across the map.

### Heatmap: bin in UV, paint once

Density is accumulated into a fixed 256x256 grid in UV space, then painted once
into an offscreen canvas and blitted. Two consequences: panning and zooming cost
nothing extra, and the grid stays aligned to the map rather than to the viewport.

The grid is rebuilt only when the filters that affect it change — accumulating ~60k
samples on every pan or playback frame would be wasteful. Grid values are
square-root scaled for display because raw counts are heavily skewed, and a linear
ramp shows one blown-out hotspot and nothing else.

### Playback without rebuilding the DOM

The animation loop calls into the store on every frame. The timeline therefore
separates a *structural* render (selection or replay settings changed — rebuild
the tick strip) from a cheap *cursor* update (move one absolutely-positioned
div). Rebuilding up to 600 tick elements per frame would drop the animation.

The event strip itself is a bonus: kills tick along the top edge of the scrubber,
deaths along the bottom, so the shape of a fight is visible before pressing play.

### No UI framework

The brief allows one, and the state is a single filter object plus a playback
object. A ~90-line observable store is less code than the wiring a framework would
need, and it keeps the render loop explicit — which matters when the frame budget
is the constraint.

## Data gotchas

Things the shipped data does not tell you, all verified rather than assumed:

| Claim in the data | Reality | Consequence |
| --- | --- | --- |
| All minimaps are 1024x1024 | 4320x4320, 2160x2158, 9000x9000 | Normalise to UV; never trust the stated size |
| Humans emit `Position`, bots `BotPosition` | 636 `Position` and 115 `Loot` events are in bot files | Classify by `user_id` |
| — | 3 files have one out-of-order timestamp pair | Sort rows on load |
| — | A match spans 13–890 ms, not minutes | Time-warp playback |
| — | Kills outnumber deaths 3.26:1 | Events are not a scoreboard; see [INSIGHTS.md](INSIGHTS.md#insight-3) |

## Performance

| Concern | Approach |
| --- | --- |
| 1,243 requests | HTTP range requests; manifest byte lengths skip hyparquet's HEAD probe |
| Repeat visits | Cache API per byte range |
| ~61k points on one map | Single canvas; bots/humans sorted once per frame, not per point |
| Pan/zoom cost | Heatmap pre-rendered to an offscreen canvas; only the blit runs |
| Playback frames | Cursor updates touch one element; tick strip rebuilt only on selection change |
| Concurrency | 24 in-flight fetches, which HTTP/2 multiplexes comfortably |
| Parse throughput | All 1,243 files decode in ~1.5s in Node; the browser path adds transfer time |

## Verification

Every claim in this document is enforced by a script that runs in CI:

| Script | Guards |
| --- | --- |
| `verify:mapping` | All 89,104 rows land inside their minimap's UV bounds |
| `verify:loader` | A restricted column read still returns `map_id`/`match_id`/`user_id` |
| `test/coordinates` | Coordinate transform, event semantics, filename id parsing |
| `test/viewport` | Fit, letterboxing, zoom/pan round-trips, anchor invariance, zoom clamping |
| `test/app-smoke` | Mounts a real `App` against a DOM and drives filters, map tabs and playback |
| `analyze` | Recomputes every figure quoted in INSIGHTS.md |

`verify:loader` and `verify:mapping` both exit non-zero on failure, and
`npm run build` runs `verify:loader`, so the exact bug described above cannot
regress into a deployed build.

The mount smoke test exists because everything else missed a whole class of bug:
typecheck finds no error in a bad DOM query, a subscription that never fires, or a
throw inside a render path. Writing it immediately found two real defects — the
panels were not populated until after the asynchronous minimap load resolved, and
`start()` resolved before any frame had been painted, so the boot overlay could
lift onto an empty canvas.