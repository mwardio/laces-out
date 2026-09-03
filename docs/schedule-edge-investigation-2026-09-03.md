# Schedule Edge investigation — 2026-09-03

## Decision

No position can safely publish directional Schedule Edge labels. Production remains
`descriptive-only`, with `labelsEnabled: false` and an empty `validatedPositions` list. Numeric
points, differentials, percentiles, projections, and coverage remain useful historical context.
Nothing in this investigation changes or reruns the admitted `laces-ros-distribution-v8` release
gate.

The prior evidence is the locked
[Schedule Edge v1 artifact](./schedule-edge-validation-2026-07-27.json). The separate
[Schedule Edge v2 preregistration](./schedule-edge-v2-preregistration-2026-09-03.json), committed
before its outcome evaluation, has protocol checksum
`045f62bc2c2d1f816f8785e05967ff7ad8cb847053bba0b8666534e70c84bff0`.

## Locked v1 replay

The replay selected `raw-equal`, exactly reproduced the three stable evidence checksums, and
released no position:

| Fold                   | Seasons   | Evidence checksum                                                  |
| ---------------------- | --------- | ------------------------------------------------------------------ |
| Candidate selection    | 2023–2024 | `57127464b705f967389d2bb482394862912475d92db6594b7b9bccc0a1e744a1` |
| Untouched confirmation | 2025      | `07e975b9f137e053f59c39f2dbdbf9f87a7e672ba36ac6e65b6befae85f2b3b8` |
| Full-window audit      | 2023–2025 | `db143047024981db6afdf598d7f3eed3585cba62fa57e3f3dfd952d4ad19bdf6` |

Selection required, independently in standard, half-PPR, and full-PPR cells, at least 300
eligible samples, 80 directional samples, Spearman rank correlation of `0.02`, a
favorable-minus-difficult residual spread of `0.35` points, and ordered
`difficult < neutral < favorable` buckets in both seasons. Confirmation kept the same correlation
and spread thresholds, lowered the evidence floors to 100 eligible and 30 directional samples,
and required ordered buckets in its one season. All three profiles had to pass.

| Position | Selection eligible / directional | Selection result and exact failure                                                                                                                                  | 2025 eligible / directional | Confirmation result and exact failure                                                                                           | Released |
| -------- | -------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------: | ------------------------------------------------------------------------------------------------------------------------------- | -------- |
| QB       |                    2,088 / 1,240 | 2/3 profiles passed. Standard had ordered buckets in only 1/2 seasons; its other gates passed (`rho = 0.076054`, spread `0.936341`, 696 eligible, 412 directional). |                 1,047 / 648 | 3/3 profiles passed.                                                                                                            | No       |
| RB       |                    2,052 / 1,413 | 1/3 passed. Standard ordered 0/2 seasons and full-PPR ordered 1/2; half-PPR ordered 2/2. All sample, correlation, and spread gates passed.                          |                 1,032 / 689 | 2/3 passed. Full-PPR ordered 0/1 season.                                                                                        | No       |
| WR       |                    1,980 / 1,353 | 0/3 passed. Standard, half-PPR, and full-PPR each ordered only 1/2 seasons. All sample, correlation, and spread gates passed.                                       |                   999 / 680 | 2/3 passed. Full-PPR ordered 0/1 season.                                                                                        | No       |
| TE       |                    2,058 / 1,357 | 0/3 passed. Spreads were `0.071322` standard, `0.076100` half-PPR, and `0.075635` full-PPR, all below `0.35`; ordered seasons were respectively 0/2, 1/2, and 1/2.  |                 1,035 / 678 | 2/3 passed. Standard rank correlation was `0.019160`, below `0.02`; its sample, directional, spread, and ordering gates passed. | No       |

The full-window audit validated QB, but that pooled result cannot repair QB's failed, predeclared
selection fold. Its other profile pass counts were RB 1/3, WR 2/3, and TE 0/3. `raw-equal` was also
the actual candidate-selection winner: score `0.085772`, compared with `0.074526` for the strongest
opponent-adjusted candidate. The result is therefore not an accidental default or a candidate
lookup failure.

### Replay method and source drift

The recorded command is
`npm --workspace @laces-out/worker run schedule-edge:validate`. The local PostgreSQL service was
reachable only on the Compose network, so the audit ran a disposable Compose worker with the
repository mounted read-only. It streamed the validator through `tsx` standard input, changing
only module-path resolution and the source selector: an in-memory map supplied the 12 checksums
already locked in the v1 artifact instead of today's `data_sources.last_checksum`. Compose supplied
the database connection inside the container; no credential was printed. The query path is
read-only, no repository or database row was changed, and the disposable container was removed.

The database still retains the locked observation rows. A stock run today selects newer admitted
stat artifacts for three seasons, so it evaluates a new evidence identity rather than reproducing
the July artifact:

| Source                            | Locked checksum and normalized rows                                        | Current checksum and normalized rows                                       |
| --------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `nflverse.stats-player-week.2023` | `ee65341b2f28cfbf48df85571bf512ec62b281043623e7ffed2926e5569126b3`, 17,788 | `f19cb71a5de0dce7fd09376026237c9ee9d5a93fe13815a2ea3ec2d37204cb17`, 17,788 |
| `nflverse.stats-player-week.2024` | `db6379707a8d520f7fb9a90eeacd8a98ec3d5cdca8b98e0943cab5a250d91a97`, 18,110 | `3ddc45a84f759aa348ce465ae001752c530575455717657cdfe1f8abfcdb4759`, 18,112 |
| `nflverse.stats-player-week.2025` | `40b67b296fda02c7f628741d4aa471208352dd42fb670d4854e7ba95295af1a6`, 18,521 | `e5e0615b3d96a3eaebfaee91e55afb4a4e7fe0caf057454177bcd7d6ad4bcfc2`, 18,522 |

The schedules, weekly rosters, and 2022 player-week stats retained their locked checksums. Source
drift does not invalidate the locked decision; it means any evaluation of the revised rows needs a
new, disclosed artifact.

## Admitted weekly and ROS evidence

ROS admission is not Schedule Edge admission. The already-produced reports provide useful model
identity and negative candidate evidence, but none supplies a validated opponent effect.

The local weekly report
`reports/weekly-validation-v9-2026-08-12.json` has SHA-256
`0efef421110068ff16502191c7674a5515e4aab14305c4232f39da1f3d2f860f`. Across its 20 completed
weekly batches, `laces-weekly-components-v9` selected `recency-only` with reason
`baseline-defended` for every Schedule Edge position. The opponent-aware contextual candidate's
MAE improvement over that baseline was negative for each position:

| Position |  Rows | Contextual improvement |
| -------- | ----: | ---------------------: |
| QB       | 1,100 |               -2.6445% |
| RB       | 2,054 |               -2.7380% |
| WR       | 3,396 |               -2.2361% |
| TE       | 2,026 |               -4.6695% |

The three `laces-ros-distribution-v8` reports have these SHA-256 identities:

| Scoring profile | Report SHA-256                                                     |
| --------------- | ------------------------------------------------------------------ |
| Standard        | `97d3ef402784b2be2388fa1446e604bba4f2c8faf6300d352026c5890e19bd2d` |
| Half-PPR        | `e51b50312e0a3b1ae76e6ada8feff3620ce3737f5c759a5d4f07e28aa6d11ae3` |
| Full-PPR        | `d43c94a7a9996a3fe33f310ce0c9d87cb889b83b5b25398ce299f265fb05bc22` |

Every one of the 36 QB/RB/WR/TE profile-by-window cells selected
`availability-aware-recency`, again with `baseline-defended`. Across the nine cells for each
position, contextual improvement ranged from -6.4477% to -0.2618% for QB, -6.9922% to -0.1447%
for RB, -13.2826% to -4.9952% for WR, and -12.2169% to -3.5227% for TE. The selected weekly and ROS
strategies have no numerical opponent multiplier. The contextual candidates do, but they were not
the admitted strategies and their negative aggregate results cannot authorize Schedule Edge
labels.

The report files live under the ignored operational `reports/` directory. Their hashes above pin
the exact local bytes used by this audit; they are evidence inputs, not committed release
artifacts.

## Persistence and 2026 evidence audit

The reusable model APIs expose row detail only while an evaluation is running:

- `runFirstPartyProjectionBacktest().predictions` contains player, position, season, week,
  contextual components, recency baseline components, and actual components. Team and opponent can
  be joined from the same `FirstPartyWeeklyStatLine` history.
- `buildHistoricalRosBacktest().heldOutSeasons[].forecasts` contains player/window contextual,
  recency, and actual totals, but not the per-week opponent attribution needed for a Schedule Edge
  label.

The saved weekly report exposes only a prediction count, and the saved ROS reports expose only a
forecast count and aggregate policy evidence. `first_party_ros_champion_artifacts` persists the
admitted policy and aggregate evidence, not held-out forecast rows. `projection_model_runs`
persists configuration, calibration, and aggregate metrics.

The local operational database did contain current production player forecasts, but not the paired
historical evidence required by v2. On 2026-09-03 it contained 306 weekly 2026 projection sets with
367,748 player rows, 21 aggregate ROS 2026 sets with 11,456 player rows, and 525,402 first-party
weekly projection observations for 2026 weeks 1–2. All weekly v9 and ROS v8 model runs were for 2026. These live rows have no completed historical outcome pairing, and the ROS summaries collapse
the remaining schedule into a window total.

The prospective fold required by the v2 preregistration is not available. At audit time,
`nflverse.schedules.2026` and `nflverse.weekly-rosters.2026` were admitted and publishable, while
`nflverse.stats-player-week.2026`, `nflverse.stats-team-week.2026`,
`nflverse.snap-counts.2026`, and `nflverse.injuries.2026` had no admitted checksum. More
fundamentally, the 2026 regular-season outcomes do not yet exist as a complete sealed fold.

The v2 evaluator must first retain checksummed, pre-outcome neutral and actual-opponent weekly
forecasts, then wait until the completed 2026 fold can be opened once under the preregistered
thresholds. The already-inspected 2025 season is diagnostic only and cannot substitute for that
confirmation. Until then, the honest result is zero validated positions, no directional labels,
and no Schedule Edge or ROS policy flip.
