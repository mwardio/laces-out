# League Scoring Normalization — Implementation Plan

- Status: **implemented and verified live 2026-07-28/29** (see "Measured results" below; the
  2026-07-28 session-state section further down is superseded by it)
- Last updated: 2026-07-29
- Companion to: `docs/ROS_AVAILABILITY_PLAN.md`, `ENHANCEMENT_PLAN.md`

**Goal:** Let a real ESPN league receive league-scored output. Today every real league is refused
outright, so rest-of-season projections, weekly forecasts, and matchup ratings all produce nothing.

**Architecture:** One function decides whether a league is scoreable. It currently answers "no" for
every ESPN league on the strength of D/ST rules that provably cannot affect a quarterback. The fix
narrows refusal to the positions actually affected, and closes a real gap in ESPN's D/ST stat map.

**Tech Stack:** TypeScript, Vitest.

---

## 0. The measured problem

Three real ESPN leagues synced on 2026-07-28. **All three fail normalization**, so none reaches
profile matching, let alone projection:

| League                | Rules | `POSITION_OVERRIDE` | `UNSUPPORTED_PLAYER_RULE` | `NONLINEAR_RULE` |
| --------------------- | ----: | ------------------: | ------------------------: | ---------------: |
| FF 2025 League        |    79 |                  10 |                         2 |                6 |
| Garagely              |    73 |                  10 |                         2 |                0 |
| The Android's Dungeon |    72 |                  10 |                         2 |                0 |

Measured eligibility, using the repo's own enumeration against the three admitted artifacts:

```
admitted profile full-ppr  -> matched leagues: 0
admitted profile half-ppr  -> matched leagues: 0
admitted profile standard  -> matched leagues: 0
TOTAL LEAGUES ELIGIBLE FOR ANY ROS PUBLICATION: 0 of 3
```

**The blast radius is not ROS.** Four call sites consume `normalizeLeagueScoringProfile`, and all
four receive the same `unavailable`:

- `apps/worker/src/first-party-ros-candidate-provider.ts:130` — rest-of-season
- `apps/worker/src/first-party-projections.ts:2544` — **weekly managed forecasts** (verified
  `unavailable` for all three leagues with the weekly component set)
- `apps/api/src/schedule-edge.ts:835` — Matchup Outlook's league-scored fantasy points allowed
- `apps/api/src/ros-projection-status.ts:484` — the status surface

So ten D/ST rules per league currently block every league-scored surface in the product.

## 1. The exact mechanism

`positionOverride` (`packages/projections/src/league-scoring.ts:698-727`) parses
`^(\d+):slot:(\d+)$`. It **already has a supported path** for D/ST overrides:

```ts
if (
  provider === "espn" &&
  slotId === "16" &&
  baseProviderStatId !== undefined &&
  baseComponent &&
  TEAM_DEFENSE_SCORING_COMPONENTS.has(baseComponent)
) {
  return { unsupported: false, baseProviderStatId };
}
return { unsupported: true };
```

That path requires `baseComponent`, i.e. `ESPN_PLAYER_SCORING_STAT_ID_MAP_V1[baseProviderStatId]`.

**None of ESPN's D/ST stat IDs are in that map.** Verified: 128, 129, 130, 131, 132, 133, 134, 206
and 209 are all unmapped. `TEAM_DEFENSE_SCORING_COMPONENTS` contains the right _component names_
(`points_allowed_0_probability`, `defensive_sacks`, and so on), but nothing translates ESPN's numeric
IDs into them. So every `:slot:16` override falls through to `{ unsupported: true }` and is fatal.

Separately, `ESPN_UNSUPPORTED_DEFENSE_STAT_IDS` (`:424`) marks 204–209 explicitly unsupported, which
produces the two `UNSUPPORTED_PLAYER_RULE` failures per league.

**This is a gap, not a decision.** The supported branch was written for exactly these rules; the
lookup table it depends on was never populated for D/ST.

## 2. The design question this plan answers

A D/ST-scoped override has no mechanism by which it can change a quarterback's projected points.
Refusing the entire league on it is not conservatism — it discards information the override provably
does not touch. But **fail-closed is the right instinct and must survive this change**: the fix is to
make refusal _position-scoped_, not to make it lenient.

**Decision: normalization gains per-position resolution.** A league whose D/ST rules cannot be
interpreted is scoreable for QB/RB/WR/TE/K and unsupported for D/ST. A league with an unparseable
rushing bonus is unsupported for every position that scores rushing.

This is a contract change: `normalizeLeagueScoringProfile` currently returns one verdict for the
whole league, and callers branch on `state !== "available"`.

---

## WP1 — Map ESPN's D/ST stat IDs

The cheapest and least invasive step, and possibly sufficient on its own for two of the three leagues.

- [ ] **Step 1: Establish the ID → component mapping from evidence, not memory.** ESPN's D/ST stat
      IDs are undocumented. The synced leagues are the evidence: their `scoring_rules` rows carry
      `provider_stat_id` and `points`. **Do not guess a points-allowed tier mapping.** An ID mapped to
      the wrong tier silently misprices every D/ST projection, which is worse than refusing the league.

  **Evidence already gathered (Garagely, read 2026-07-28) — verify against all three leagues before
  committing any of it.** Every `:slot:16` override carries the real value while the bare ID carries
  0.0, so the override rows are the scoring ladder:

  | `provider_stat_id` | points | reading                           |
  | ------------------ | -----: | --------------------------------- |
  | `128:slot:16`      |     +5 | points allowed, shutout tier      |
  | `129:slot:16`      |     +3 | next tier down                    |
  | `130:slot:16`      |     +2 |                                   |
  | `131`              |    (0) | present, no override              |
  | `132:slot:16`      |     −1 |                                   |
  | `133:slot:16`      |     −3 |                                   |
  | `134:slot:16`      |     −5 |                                   |
  | `135:slot:16`      |     −6 |                                   |
  | `136:slot:16`      |     −7 |                                   |
  | `123:slot:16`      |     −1 | parallel **yards**-allowed ladder |
  | `124:slot:16`      |     −3 |                                   |
  | `125:slot:16`      |     −5 |                                   |

  Two structural confirmations, neither relying on recall: the 128→136 sequence is strictly
  monotonically descending with no gaps, which is the shape of a points-allowed ladder and of almost
  nothing else; and 123/124/125 form a second, parallel ladder with the same −1/−3/−5 spacing, which
  is the yards-allowed band. `TEAM_DEFENSE_SCORING_COMPONENTS` already contains matching component
  names (`points_allowed_0_probability` and siblings), so the target vocabulary exists — only the
  numeric lookup is missing.

  **What remains genuinely unestablished:** the exact _boundary_ each tier represents (whether `129`
  is 1–6 or 1–7 points allowed) is not derivable from point values alone, and ESPN's own settings UI
  is the only place that states it. If a tier's boundary cannot be established, map only what is
  certain and leave the rest unmapped — an unmapped ID withholds D/ST under WP2, which is correct.
  `206` and `209` remain separately marked in `ESPN_UNSUPPORTED_DEFENSE_STAT_IDS`.

- [ ] **Step 2: Write the failing test** using the three real leagues' rule sets as fixtures
      (sanitized: stat IDs and points only, no league names or member data).
- [ ] **Step 3: Populate the map** for the IDs you can establish with confidence. Leave genuinely
      unknown IDs unmapped — they will be handled by WP2's position scoping rather than forced.
- [ ] **Step 4: Re-measure.** Re-run the normalization check against all three leagues and report the
      remaining failure codes.

**Exit criteria:** every D/ST stat ID that is mapped is mapped on evidence, with its source recorded;
unknown IDs remain unmapped rather than guessed.

---

## WP2 — Position-scoped normalization

- [ ] **Step 1: Extend the result contract.** `normalizeLeagueScoringProfile` returns per-position
      support alongside the existing profile — which positions are scoreable, and for each unsupported
      position, the reasons. Keep the existing whole-league `state` for the case where _no_ position
      is scoreable.
- [ ] **Step 2: Attribute every fatal reason to positions.** A rule scoped `:slot:16` affects D/ST
      only. A rule for `rushing_yards` affects every position that can rush. An unattributable rule
      must fail **all** positions — attribution defaults to pessimistic, never optimistic.
- [ ] **Step 3: Update the four callers** to consume per-position support:
      `first-party-ros-candidate-provider.ts:130`, `first-party-projections.ts:2544`,
      `schedule-edge.ts:835`, `ros-projection-status.ts:484`. Each must withhold the unsupported
      positions and project the rest, with the reason surfaced per position rather than per league.
- [ ] **Step 4: Profile-key semantics.** `projectionScoringProfileKey` currently hashes the whole
      profile, and admitted ROS artifacts match on exact equality. Decide — and record — whether a
      partially-supported league matches an artifact on the positions it _does_ support, or is
      excluded entirely. **This is the load-bearing decision of the package**: get it wrong and either
      leagues silently receive projections scored under rules they do not use, or the fix delivers
      nothing. Do not proceed to Step 5 until it is written down and justified.
- [ ] **Step 5: Isolation and honesty tests.** A league unsupported for D/ST must receive no D/ST
      projection, must receive QB/RB/WR/TE projections, and must report why D/ST is missing.

**Exit criteria:** at least one of the three real leagues produces QB/RB/WR/TE output; no league
receives a projection for a position whose rules could not be interpreted; every withheld position
states its reason.

---

## WP3 — Nonlinear rules (FF 2025 League only)

Six `NONLINEAR_RULE` failures, from thresholded or bucketed rules that "cannot be reconstructed from
a projected total" — a yardage bonus is the archetype.

This is genuinely harder than WP1 or WP2: a bonus at 100 rushing yards depends on the _distribution_
of the outcome, not its mean, so it cannot be applied to a point projection at all.

- [ ] **Step 1: Determine which positions each nonlinear rule affects**, and confirm WP2's scoping
      already withholds exactly those.
- [ ] **Step 2: Decide whether the Monte Carlo path can apply threshold rules per simulated path.**
      The ROS engine simulates full stat lines, so a bonus _is_ computable there even though it is not
      computable against a weekly point estimate. If so, ROS and weekly legitimately differ in what
      they support, and that difference must be visible rather than implicit.
- [ ] **Step 3: If it cannot be supported, withhold the affected positions with a stated reason.**
      An approximated bonus is worse than an absent one.

**Exit criteria:** nonlinear rules either apply correctly per simulated path, or withhold exactly the
positions they affect — never silently ignored.

---

## Non-negotiables

- **Fail closed, but scope the failure.** An uninterpretable rule must withhold what it affects. It
  must never be dropped silently, and it must never be approximated.
- **Never guess a stat ID's meaning.** A wrong mapping silently misprices projections. Unknown stays
  unknown, and unknown withholds.
- **Attribution is pessimistic.** A rule that cannot be attributed to specific positions fails all of
  them.
- **Sanitize fixtures.** Stat IDs and point values only — no league names, team names, or member data.

## What this plan does not claim

- It does not promise all three leagues become fully scoreable. FF 2025 League's nonlinear rules may
  legitimately withhold positions, and some D/ST IDs may stay unmapped.
- It does not address the ROS availability gate, the live release gate, or the untouched protocol —
  those are `docs/ROS_AVAILABILITY_PLAN.md`, and they are downstream of this. **Nothing there matters
  until a league normalizes.**

## Measured results — 2026-07-29 (supersedes everything below)

All three work packages were implemented and reviewed; the full monorepo suite passed 1944/1944.

**Corrected evidence (supersedes §WP1's provisional table, which was inverted):** ESPN 128–136
are the YARDS-allowed brackets (community vocabulary + exact ESPN-default value correspondence,
triple-sourced); the points-allowed ladder (89–92, 121–125) was already mapped. The measured
10 `POSITION_OVERRIDE` failures were 8 bracket overrides + the 206/209 overrides; nothing new
was honestly mappable, and D/ST stays withheld on 206/209 (209 unestablished).

**Live outcomes (verified against the running stack):**

- Normalization: Garagely + The Android's Dungeon `available` with QB/RB/WR/TE/K supported,
  DST withheld with stated reasons; FF 2025 `available` with K only (six per-game yardage
  bonuses withhold QB/RB/WR/TE, per-position, evidence-attributed).
- Weekly rail: first league sets ever published — 1128/1128/54(K-only) rows, pre-draft
  coverage marked (operator-decided pre-draft publication; partial syncs still fail closed).
- ROS rail: two league-shaped catalog profiles (`espn-standard-2pt`, `espn-standard-2pt-nxm`)
  validated at n8 (evidence-ready, ZERO blockers, 4.4h each) and admitted 2026-07-29 with
  `admittedCellBlockers: []`. Live readiness: both leagues' profiles matched, all five rail
  positions READY; remaining league facts are `insufficient-candidate-inputs` (pre-draft;
  clears at draft) and `stale-source` (upstream schedules changed 23:16Z; clears on ingest).
- The live release gate was NOT modified (untouched-protocol territory): whole-key equality is
  satisfied by construction because the leagues' normalized supported-subset profiles ARE the
  new catalog profiles. Per-position evidence identity for partially-matched leagues remains
  `docs/ROS_AVAILABILITY_PLAN.md` work; the inertness is pinned by a production-shaped test.
- Shakedown: 9 surfaces × 3 leagues — zero broken, zero 500s (probe log:
  `shakedown-results.md` in the session dir). Known follow-ups recorded there and in the
  ledger (offseason `currentWeek` gate on two status summaries; per-player matchup reasons;
  pre-draft pool presentation; `metrics.leagues.notes` has no reader yet).

## Session state as of 2026-07-28 — read this before resuming (SUPERSEDED 2026-07-29)

**The agreed mission:** implement this plan, then run an end-to-end shakedown against the three
synced leagues, fix what it finds, and report a specific list of what works and what does not — a
list, not a verdict. Expect the shakedown to find problems: on 2026-07-28 every surface that met real
data for the first time failed (ESPN payload shape, profile matching, normalization — three for
three within ninety minutes). Those surfaces were built against fixtures, exactly like the ones that
failed.

**Never exercised against a real league**, and therefore the likely next tier of problems: Decision
Desk lineup/waiver/trade output, Matchup Outlook roster outlook, the draft analyzer, change events,
the `league-sync` worker service, and the trade builder.

**Outstanding, not blocking this plan:**

- `~/stacks/caddy/Caddyfile` is edited and validates but **needs a Caddy reload**; until then the
  Cloudflare analytics beacon stays blocked. That file is outside the repo and unversioned. Backup:
  `Caddyfile.bak-pre-cloudflare-analytics-20260728-123530`.
- The **worker container has not been rebuilt** since the ROS gate work landed. `api` and `web` were
  rebuilt and deployed 2026-07-28.
- `docs/ros-v6-2026-untouched-protocol.md` needs an **Amendment 4** ratified by the operator: it
  freezes the availability MAE gate as a point comparison, which the evidence-test change supersedes.
  `docs/PROJECTIONS.md` and the withheld-cell copy in `apps/web/src/app/methodology/evidence.ts` are
  stale for the same reason.
- The **live release gate** (`rest-of-season.ts:3105`) still uses the superseded point comparison;
  only the report-side gate was changed.
- Three ROS artifacts per profile are admitted with `admittedCellBlockers: []` as of 2026-07-28.
- Five tests flake under CPU contention (they sit near the 5 s vitest default): `content-script`,
  `app`, `league-dashboard`, `change-event-notifications.pg`, `first-party-ros-candidate-provider`.
  Each passes in isolation. Distinguish these from real failures.

## Execution checklist

1. Read this plan and section 2.2 of `ENHANCEMENT_PLAN.md`.
2. Re-measure before starting — the three synced leagues are the ground truth, and the numbers above
   are dated.
3. WP1 first; it may resolve two leagues on its own and is independent of the contract change.
4. Do not start WP2 Step 5 before Step 4's profile-key decision is written down.
5. Run the completion commands before declaring any package done.
6. Record measured results with dates; supersede rather than overwrite.
