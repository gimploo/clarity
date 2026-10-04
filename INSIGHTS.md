# Insights from the LILA BLACK telemetry

Three findings from 1,243 files, 89,104 samples, 796 matches and 339 players
across three maps over five days.

Every figure below is reproducible with `npm run analyze`, which prints the full
tables these numbers are taken from.

---

## Insight 1 — On every map, the busiest place is the safest

The most-trafficked 32x32 grid cell on each map is also the cell with the most
loot pickups — and on all three maps it records **zero deaths**. The deadliest cell
is somewhere else entirely.

| Map | Busiest cell | Samples | Loot | Deaths | Kills |
| --- | --- | ---: | ---: | ---: | ---: |
| Ambrose Valley | `(-49, -354)` | 1,336 | 583 | **0** | 4 |
| Grand Rift | `(-79, 12)` | 138 | 44 | **0** | 1 |
| Lockdown | `(-297, -109)` | 560 | 137 | **0** | 3 |

The deadliest cell is a different place in each case:

| Map | Deadliest cell | Deaths | Samples | Loot | Kills |
| --- | --- | ---: | ---: | ---: | ---: |
| Ambrose Valley | `(8, -8)` | 41 | 1,123 | 182 | 65 |
| Grand Rift | `(7, -26)` | 4 | 133 | 7 | 6 |
| Lockdown | `(114, -15)` | 12 | 296 | 31 | 17 |

On Ambrose Valley the busiest cell holds **19% more traffic** than the deadliest
cell, yet not one recorded death. The centre cell `(8, -8)` has fewer samples but
accounts for the top kill count (65) and the top death count (41) on the map — yet
it ranks only **15th of the map's cells by loot pickups** (182), against 583 for
the busiest cell. The two superlatives are genuinely uncorrelated.

**Why it matters.** Loot and danger are spatially decoupled. Players can farm the
highest-value loot on the map without meaningful risk, while the centre functions
as a near-pure death trap. If the intent is that loot should be contested, the
reward placement and the fight geography are pulling in opposite directions.

**How to use it.** In the app, select a map, switch on **Deaths** and **Loot**, and
compare the two heatmaps. They light up in different places.

---

## Insight 2 — More than half of every map is dead space

Binning each map into a 32x32 grid and counting cells that ever received a sample:

| Map | Cells touched | Coverage | Share of samples in busiest 10% of cells |
| --- | --- | ---: | ---: |
| Ambrose Valley | 443 / 1024 | 43.3% | 66.7% |
| Grand Rift | 376 / 1024 | 36.7% | 66.5% |
| Lockdown | 333 / 1024 | 32.5% | 73.0% |

Ambrose Valley has 566 matches and 68.5% of all samples, yet **57% of its area is
never visited by a single player**. Lockdown is worse: the busiest tenth of the map
absorbs 73% of all movement.

The pattern is consistent, but the geography differs by map. Ambrose Valley and
Grand Rift both peak at the map centre. Lockdown does not — its busiest cell sits
at `u = 0.20`, far west of centre, and the same cell is also its loot hotspot
(137 pickups). Ambrose Valley's busiest cell is far south at `v = 0.13`.

**Why it matters.** Either the maps are sized well above what the current match
format supports, or players are funnelled into a small central corridor and the
surrounding geometry is doing no work. Lockdown suggests the latter — it has a
single dominant western anchor rather than a centre-weighted one, which reads like
one POI the rotation orbits rather than a map that is uniformly contested.

**How to use it.** Pick a map, leave the filter at "All matches", turn off
**Humans** and **Bots** so nothing is drawn on top, and read the empty region
against the terrain. Empty region is unbuilt space.

---

## Insight 3 — The export cannot be read as a scoreboard

Every kill in a match produces exactly one death, so kill and death event counts
should roughly balance. They do not:

| Measure | Value |
| --- | --- |
| Kill events | 2,418 |
| Death events | 742 |
| **Ratio** | **3.26 : 1** |
| Matches with combat | 751 |
| Matches where kills == deaths | 103 (13.7%) |
| Files recording a kill | 951 / 1,243 |
| Files recording a death | 740 / 1,243 |

The asymmetry is concentrated in bots, which are the only source of meaningful
combat at all: bot files average **5.2 kills and 1.6 deaths** each. Human-vs-human
combat is negligible — 3 kills against 3 deaths in the entire dataset.

This is compounded by what the matches actually contain:

| Measure | Value |
| --- | --- |
| Matches with no bots | 744 (93.5%) |
| Matches with no humans | 16 (2.0%) |
| Mixed matches | 36 (4.5%) |
| Median humans per match | 1 (max 2) |
| Median bots per match | 0 (max 15) |

Only **36 of 796 matches (4.5%) contain both a human and a bot**, and 52 (6.5%)
contain a bot at all.

**Why it matters.** Two consequences, and they point in opposite directions:

1. **Do not use this data for balance work.** Kill/death counts, K/D ratios and
   time-to-kill computed from these files would be wrong by a factor of three. The
   missing deaths are almost certainly bots whose files are absent or truncated
   rather than genuinely surviving.
2. **Do not use this data to evaluate PvP design.** With a median of one human per
   match, the dataset contains almost no evidence about how the game plays when
   people meet each other. Any tuning decision about human combat made from these
   files would be unfounded.

**How the tool handles it.** Kills and deaths are drawn as independent, per-subject
events. The app never pairs a kill with a death or derives a scoreboard from them,
because doing so would require the symmetry that is not present. The timeline
counts kills and deaths separately and labels them as such.

---

## Secondary observations

**Volume decays steadily across the five days.** 33,687 samples on 10 Feb, then
21,235, 18,429, 11,106, and 4,647 on 14 Feb — an 86% drop. This reads as a
telemetry export that was progressively narrowed or interrupted, not as a player
population that fell off, so day-over-day comparisons are not safe. 220 of 339
players appear in more than one match, so the sample is not disjoint per day.

**Grand Rift is severely under-sampled.** 59 matches and 7.7% of samples, against
566 and 68.5% for Ambrose Valley. Its hottest cell holds 138 samples versus 1,336
for Ambrose Valley. Findings from Grand Rift are correspondingly weaker, and the
map is the least represented in rotation.

**The storm is not a meaningful threat in this data.** 39 storm deaths out of 742
total deaths — 5.3% — spread thinly across all three maps with no cell exceeding
2 deaths. Either the storm rarely closes on players, or storm deaths are
under-reported in the same way player deaths are (Insight 3).

**Map rotation is heavily skewed.** Ambrose Valley takes 68.5% of all samples
across 566 of 796 matches. Lockdown sits at 23.8% / 171 matches and Grand Rift at
7.7% / 59. If the goal is balanced exposure across maps, the current rotation
achieves neither.