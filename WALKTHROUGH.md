# Walkthrough

A scripted five-minute tour of Clarity, with the insight it demonstrates at each
step. All figures quoted are reproducible with `npm run analyze`.

Live at <https://gimploo.github.io/clarity/>.

---

## 0. Loading (≈5 seconds, once)

The app shows a progress bar reading `Loading telemetry 612 / 1243 (3.4 MB)`.

It is fetching 1,243 Parquet files using HTTP **range** requests — only the footer
and the columns actually needed come across, not whole files. On a repeat visit
most of this is served from the browser Cache API and finishes much faster.

Watch the header: if it says **whole files**, the host did not honour `Range`, and
the loader fell back to whole-file reads. GitHub Pages does honour `Range`, so you
should see a load time instead.

---

## 1. First look — everything at once

You land on **Ambrose Valley** with every journey drawn: 566 matches, 68.5% of the
dataset.

Notice two things immediately:

- **Cyan and magenta paths overlap heavily near the centre** and thin out towards
  the edges. That is not a rendering artefact — it is the coverage gap in
  [Insight 2](INSIGHTS.md#insight-2).
- **Orange crosses and red triangles cluster in the middle** while yellow loot
  squares hug the south and west edges.

Click **Zoom to data**. The viewport frames the populated region and you can see
how much of the map is empty.

---

## 2. Provenance — is this map correctly aligned?

Worth doing once before trusting any spatial claim.

1. Click **Reset view** (`0`).
2. Note the busiest area — around the map centre.
3. Compare the drawn paths against the minimap's terrain.

If the transform were wrong, every path would collapse into a corner or vanish
off-canvas. `npm run verify:mapping` asserts this mechanically: all 89,104 rows
land inside the unit square for their map.

The subtler version of this failure: the data README claims every minimap is
1024x1024, and all three are wrong. See
[ARCHITECTURE.md](ARCHITECTURE.md#coordinates-normalise-to-uv-never-to-pixels).

---

## 3. Insight 1 — the busiest place is the safest

This is the core finding.

1. Stay on **Ambrose Valley**, all days, all matches.
2. Set **Heatmap → High-traffic areas**.
3. Note the hottest cell: UV `(0.36, 0.13)`, far south, world `(-49, -354)`.
4. Switch to **Heatmap → Death zones**.

The death heatmap lights up somewhere completely different — the centre, around
world `(8, -8)`.

Now prove it precisely:

5. Turn the heatmap **off** and turn **Loot** and **Deaths** on (both default off /
   on respectively; toggle as needed).
6. The southern cell has **583 loot pickups and 0 deaths**.
7. The central cell `(8, -8)` has **41 deaths and 65 kills**, but ranks only 15th
   by loot.

| | Busiest cell `(-49, -354)` | Deadliest cell `(8, -8)` |
| --- | ---: | ---: |
| Samples | 1,336 | 1,123 |
| Loot | 583 | 182 |
| Kills | 4 | 65 |
| **Deaths** | **0** | **41** |

Switch to **Grand Rift** and **Lockdown** and the pattern repeats: on all three
maps the single busiest cell is also the lootiest, and has zero deaths.

> **Takeaway.** Loot placement and combat geography are decoupled. The
> highest-value loot on the map is uncontested; the centre is a death trap with
> comparatively little loot to justify it.

---

## 4. Inspecting a single player

1. Clear the **Match** filter back to *All matches*.
2. Use **Player** to pick a human (`1298e3e2...` style uuid).
3. Their single journey draws alone in cyan — this is the clearest view of one
   player's path in the whole dataset.
4. Hover anywhere along the path.

The tooltip gives the raw event name, match-relative time, and **world** `x, z`
coordinates — the last is what you would paste into a level editor to go look at
the space.

Note the event names are **subject-relative**. A red triangle labelled `BotKilled`
means *this player* was killed by a bot. Read
[ARCHITECTURE.md](ARCHITECTURE.md#events-are-subject-relative) before drawing
conclusions about combat.

---

## 5. Timeline playback

1. Pick a **match** from the Match filter.
2. The timeline activates with an event strip: **kills along the top edge, deaths
   along the bottom**.
3. Press **Play**.

Watch the heads move. Every participant shares one playhead because timestamps are
rebased per match, so their positions are directly comparable.

**Why the replay is 8 seconds:** a whole match spans only **13–890 ms** in the raw
data. The control is a target replay length rather than a speed multiplier for
exactly this reason — "0.05x" is not a meaningful choice, "watch this over 8
seconds" is. Try 2s and 30s.

Drag the scrubber to jump to a fight. Because kills and deaths are separate ticks,
you can find the contested moments without watching the whole thing.

---

## 6. Insight 3 — why the tool refuses to show a scoreboard

1. With a match selected, read the timeline readout: `kills 65  deaths 12`.
2. That ratio is impossible in a real match — every kill produces exactly one
   death.

Across the whole dataset the ratio is **2,418 kills to 742 deaths, 3.26:1**. Only
**103 of 751** combat matches balance.

So the app never pairs kills with deaths and never shows a K/D figure. To find out
why, read
[Insight 3](INSIGHTS.md#insight-3-the-export-cannot-be-read-as-a-scoreboard) —
it also explains that with a median of **1 human per match**, this dataset cannot
tell you anything about how human PvP feels.

---

## 7. Heatmap modes side by side

| Mode | Answers |
| --- | --- |
| **High-traffic areas** | Where do players actually spend time? |
| **Kill zones** | Where does combat happen? |
| **Death zones** | Where do players die? |

Comparing **Kill zones** against **Death zones** on Ambrose Valley shows the two
overlap heavily around the centre, which is the expected shape for a symmetric
fight. Comparing either against **High-traffic areas** is what surfaces Insight 1.

Drag **Opacity** to about 40% to read the minimap terrain underneath a heatmap —
useful for identifying what is actually built at a hot location.

---

## 8. Coverage gap

1. Click the **Grand Rift** tab (59 matches, 7.7% of samples).
2. Use **Zoom to data**, then pan.
3. Only **36.7%** of the map's grid cells ever received a sample.

Grand Rift is the least-played and least-sampled map, so its findings are the
weakest of the three. Its busiest cell holds 138 samples against Ambrose Valley's
1,336. Treat Grand Rift conclusions as directional.

---

## Things worth trying

- **Bots only.** Turn **Humans** off. 461 bot files across 52 matches — this is
  where essentially all the combat is.
- **Loot on its own.** Turn **Loot** on, everything else off. 12,885 pickups; the
  distribution is extremely clustered.
- **A single day.** Pick 10 Feb in the day filter — it holds 33,687 samples,
  roughly half the dataset in one day.
- **One player, one match.** The tightest view of a single journey, with playback.