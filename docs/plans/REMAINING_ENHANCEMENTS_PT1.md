# Remaining Enhancements Pt 1 — Implementation Plan

- Status: proposed
- Last updated: 2026-07-27
- Companion to: `ENHANCEMENT_PLAN.md` (roadmap), `docs/plans/SCHEDULE_INTELLIGENCE_PLAN.md` (shipped)

**Goal:** Reach the finished work that is already sitting behind an unwired route, an untyped
settings blob, or a missing surface, and expose it — without adding a provider, a data vendor, or a
model.

**Architecture:** Ten independently shippable vertical slices plus one ledger correction. Most
consume engines, schemas, or adapters that already exist and are already tested; they add typed
contracts, bounded authorized reads, routes, and surfaces. The orchestration packages build on
existing queues and persistence rather than introducing another provider, data vendor, or model.
Pure calculation stays in `packages/*`; authorization, bounded database reads, source admission,
and response assembly stay in `apps/api`. Provider-neutral services shared by the API and worker
must move into a package rather than making one app import the other.

**Tech Stack:** TypeScript, Fastify, Drizzle/PostgreSQL, pg-boss, Next.js App Router, Vitest.

---

## Global Constraints

Every package's requirements implicitly include this section. Values are copied from
`ENHANCEMENT_PLAN.md` §0 and §2.

- Provider access is read-only. Laces Out prepares decisions and links users to the host; it does
  not submit lineups, waiver claims, trades, or draft actions.
- Do not expose a raw per-account source selector. Show provenance, freshness, confidence, and
  degraded-source states instead.
- Yahoo sync is described publicly only as **Coming Soon**. Do not mention developer review, API
  approval, or internal access status in product copy.
- Never accept or store ESPN passwords, cookies, `espn_s2`, or `SWID` values.
- Deterministic engines decide and score. The language model may retrieve, organize, explain, and
  challenge those results; it must not invent players, transactions, projections, or league state.
- Managed AI uses `gemini-3.6-flash` with a managed budget of 50 requests per user per UTC day.
  Model selection is available only for BYOK users.
- Mobile and desktop must both remain production quality. Avoid generic dashboard styling,
  gratuitous gradients, oversized typography, terminal fonts, emojis, and decorative clutter.
- Copy is direct and professional. No references to assisted authorship or session mechanics.
- Forward-only database migrations. Do not weaken security or validation to make a deploy pass.
- Every recommendation-shaped output retains algorithm version, input checksum, data freshness, and
  warnings (ADR 0003). Stochastic algorithms use explicit seeded pseudo-randomness.
- New contracts live in focused domain modules; `packages/contracts/src/index.ts` remains a
  re-export barrel rather than receiving additional large inline domains.
- Do not add GitHub Actions or workflow files.
- Keep local ESPN capture tooling, captures, and sanitized response artifacts local and uncommitted.
- Preserve unrelated working-tree changes. Deploy, commit, and push only when asked.

**Completion commands** — before declaring any package complete:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
```

---

## 0. Scope

### In scope

| WP   | Plan ID | Deliverable                                                                            |
| ---- | ------- | -------------------------------------------------------------------------------------- |
| WP0  | —       | Ledger corrections in `ENHANCEMENT_PLAN.md`                                            |
| WP1  | C6 + D6 | Typed league rules, then playoff odds and seed distributions in League Analytics       |
| WP2  | B6      | Draft analyzer exposed through API and Draft Studio — **complete**                     |
| WP3  | D4 + D5 | Trade builder with conditional weekly/ROS valuation — **D4 complete; D5 gated on WP9** |
| WP4  | A1      | Provider-aware sync and recommendation-recompute orchestration — **complete**          |
| WP5  | A6 + D9 | Change-event write, read, and dashboard surface — **complete**                         |
| WP6  | A5      | Unresolved identity observability                                                      |
| WP7  | E1      | Typed deterministic AI tools                                                           |
| WP8  | —       | `docs/provider-notes/sleeper.md` for the already-shipped Sleeper source                |
| WP9  | C3      | ROS release observability and common scoring-profile coverage                          |
| WP10 | —       | Public forecast methodology and validation receipts                                    |

### Explicitly out of scope

- **C4 Sleeper league connector.** Deferred by product decision on 2026-07-27: no current league
  member uses Sleeper, so a third provider serves no one today. Revisit if the product is opened to
  a wider audience. Sleeper's already-shipped player catalog and add/drop trends are unaffected and
  keep running.
- **`/v1/state/nfl` as a canonical current-week source.** Deferred with C4 — it is a Sleeper
  endpoint, and the same decision applies. Reconsider alongside C4.
- **ESPN live-draft DOM validation** (`docs/plans/ESPN_LIVE_DRAFT_SYNC_PLAN.md` WP0/WP5) and anything
  depending on it.
- **Yahoo sync.** Remains **Coming Soon**. Work in this plan may preserve or test its existing
  contracts but must not present it as currently available.
- **D7 Stats Center fantasy points allowed.** See §11 — it needs a route-scoping decision first.
- **A3 second independent projection source.** Requires the §2.1 source-admission checklist.

### A note on task granularity

WP0 and WP1 are written as bite-sized steps with real test code, because they are next. WP2 through
WP10 are written at task granularity — files, interfaces, exit criteria, and what each test must
assert — because several of them consume interfaces that WP1 and WP4 have not produced yet, and
step-level code written now would be guesswork that ages badly.

**Before starting any of WP2–WP10, expand that package into bite-sized steps first**, using WP1 as the
template. That expansion is part of the package, not overhead before it.

### Ordering and dependencies

```
WP0 ──▶ (everything; five minutes, prevents rework)
WP1 (C6) ──▶ WP1 (D6)
WP2, WP3 builder, WP6, WP8 ── independent, any order
WP4 recompute + existing provider ingestion ──▶ WP5
WP9 scenario-contract fix ──▶ WP10; current public proof claims deserve receipts
WP9 scoring coverage ──▶ WP3 multi-horizon coverage
WP7 ── last; it wraps everything above
```

---

## WP0 — Ledger corrections

The `ENHANCEMENT_PLAN.md` progress ledger is wrong in ways that would cause duplicate work. Fix it
before anything else.

**Files:** Modify `ENHANCEMENT_PLAN.md` and stale ROS wording in `docs/operations.md` and
`packages/projections/README.md`.

- [ ] **Step 1: Correct the D4 row and the Package D ledger entry**

D4 is substantially implemented. `apps/api/src/in-season-decisions.ts:856-909` (`tradePackages`)
generates bounded 1-for-1, 2-for-1, and 1-for-2 packages; `:1546-1575` produces distinct `bestForMe`
(profitable) and `fairest` (mutually beneficial, ranked by `fairnessGap`) views; `evaluateTrade`
handles forced drops and roster legality. Only the builder (WP3) and multi-horizon valuation (D5,
ROS-gated) remain.

- [ ] **Step 2: Correct the Package D ledger entry for D1 and boom/bust**

D1 shipped in commit `354d0e6` (Schedule Edge), with directional labels withheld pending the
historical gate (`apps/api/src/schedule-edge.ts:1497-1499`). Boom/bust is implemented
(`deriveBoomBust` in `packages/league-analytics/src/opportunity.ts`). The ledger lists both as
outstanding.

- [ ] **Step 3: Record the weekly awards and game-day alerts work**

Commits `f908699` and `cad7c9d` are absent from the ledger.

- [ ] **Step 4: Note the deferred C4 decision in the Package C ledger entry**

Record that Sleeper league connection is deferred by product decision, not by a technical blocker,
so a future session does not re-plan it.

- [ ] **Step 5: Correct the C3 and D5 status**

The v8 ROS release artifact for the admitted full-PPR scoring profile is evidence-ready and the
league-scoped production persistence path exists. C3 is no longer accurately described as a wholly
shadow-only model, but WP9 Task 9.0 identifies a live scenario-count/persistence mismatch that must
be fixed before the first real league publication can be considered production-ready. Record the
narrower truth: after that correction, release remains conditional on an exact admitted scoring
profile, complete league inputs, and live per-cell gates. D5 can consume a compatible ROS set when
one exists and degrade to weekly-only valuation with a stated reason when it does not.

- [ ] **Step 6: Separate legacy shadow-audit language from production release status**

Update stale documentation that says the whole ROS capability cannot publish. Preserve the shadow
audit's purpose, but describe it as a separate diagnostic rail rather than the authoritative
production eligibility signal.

- [ ] **Step 7: Verification checkpoint**

Review the ledger diff against current code and the admitted artifact before proceeding. Do not
commit unless explicitly asked.

---

## WP1 — Typed league rules and playoff odds (C6, D6)

### Why it is ready

The data is already captured and stored. `NormalizedLeagueSettings.operationalRules`
(`packages/connectors/src/normalized.ts:31-52`) carries keeper count, regular-season matchup
periods, playoff matchup period length, playoff seeding rule, matchup tie rules, median-game state,
trade deadline, veto votes, and divisions. ESPN's normalizer populates it
(`packages/connector-espn/src/web-client-normalizer.ts:1397`), and both sync paths persist the whole
settings object into `league_seasons.settings` via `plainRecord(...)`
(`apps/api/src/espn-sync-persistence.ts:447,472`, `apps/api/src/yahoo-sync.ts:577,603`).

Nothing reads it in a typed, validated way. `apps/api/src/schedule-edge.ts:789-791` reaches into the
blob with ad-hoc helpers — that is the second reader to need this, which is the signal to extract it.

`simulatePlayoffOdds` (`packages/league-analytics/src/playoffs.ts:207`) is 389 tested lines with
**zero production callers**. `apps/api/src/league-analytics.ts:270-287` already reads
`weekly_matchups` joined through `matchup_snapshots` for the league season, with week, status,
scores, and both team IDs — which is exactly the shape the simulator's `remainingMatchups` needs.

### Files

- Create: `packages/contracts/src/league-rules.ts` — typed rule schema and parser
- Create: `packages/contracts/src/league-rules.test.ts`
- Create: `apps/api/src/playoff-odds.ts` — assembly from analytics rows to simulator input
- Create: `apps/api/src/playoff-odds.test.ts`
- Modify: `packages/contracts/src/index.ts` — re-export league rules
- Modify: `apps/api/src/league-analytics.ts` — read typed rules, add playoff odds to the response
- Modify: `apps/api/src/league-analytics.test.ts`
- Modify: `apps/api/src/schedule-edge.ts:789-791` — replace ad-hoc settings reads with the parser
- Modify: `apps/web/src/components/league-analytics-workbench.tsx` — playoff odds section
- Modify: `apps/web/src/components/league-analytics-workbench.module.css`
- Modify: `packages/connector-yahoo/src/xml.ts` — populate `operationalRules` where the XML supports it

### Interfaces

**Produces** (relied on by WP5 and WP7):

```ts
// packages/contracts/src/league-rules.ts
export interface LeagueRules {
  readonly teamCount: number;
  readonly draftType: "snake" | "auction" | "offline" | "unknown";
  readonly auctionBudget: number | null;
  readonly waiverType: "faab" | "rolling" | "reverse-standings" | "free-agent" | "unknown";
  readonly faabBudget: number | null;
  readonly playoffTeamCount: number | null;
  readonly acquisitionLimit: number | null;
  readonly matchupAcquisitionLimit: number | null;
  readonly minimumBid: number | null;
  readonly waiverProcessDays: readonly number[];
  readonly waiverProcessHour: number | null;
  readonly regularSeasonMatchupPeriods: number | null;
  readonly playoffMatchupPeriodLength: number | null;
  readonly playoffSeedingRule: string | null;
  readonly matchupTieRule: string | null;
  readonly playoffMatchupTieRule: string | null;
  readonly scoringType: string | null;
  readonly medianGameEnabled: boolean | null;
  readonly keeperCount: number | null;
  readonly tradeDeadlineAt: string | null;
  readonly tradeReviewHours: number | null;
  readonly vetoVotesRequired: number | null;
  readonly divisions: readonly { readonly providerDivisionId: string; readonly name: string }[];
  /** Fields the provider did not supply, for honest UI and provenance. */
  readonly missing: readonly string[];
  /** Known rules the current playoff simulator cannot model faithfully. */
  readonly unsupportedForPlayoffOdds: readonly string[];
}

export function parseLeagueRules(settings: unknown): LeagueRules;
```

`parseLeagueRules` never throws on a malformed blob. Unparseable or absent fields become `null`,
`unknown`, or an empty bounded collection as appropriate and are listed in `missing`. A rule that
is absent must never be silently defaulted to a plausible value — an unknown `playoffTeamCount`
withholds playoff odds rather than assuming six. Division seeding, median games, and unsupported
provider tiebreakers are listed in `unsupportedForPlayoffOdds` until the engine models them.

### Bite-sized tasks

#### Task 1.1: Typed league-rule parser

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/league-rules.test.ts
import { describe, expect, it } from "vitest";

import { parseLeagueRules } from "./league-rules.js";

describe("parseLeagueRules", () => {
  it("reads operational rules from a stored ESPN settings blob", () => {
    const rules = parseLeagueRules({
      teamCount: 12,
      playoffTeamCount: 6,
      operationalRules: {
        regularSeasonMatchupPeriods: 14,
        playoffMatchupPeriodLength: 1,
        medianGameEnabled: false,
        keeperCount: null,
        tradeDeadlineAt: "2026-11-25T05:00:00.000Z",
        divisions: [{ providerDivisionId: "0", name: "East" }],
      },
    });

    expect(rules.teamCount).toBe(12);
    expect(rules.playoffTeamCount).toBe(6);
    expect(rules.regularSeasonMatchupPeriods).toBe(14);
    expect(rules.divisions).toEqual([{ providerDivisionId: "0", name: "East" }]);
    expect(rules.missing).toContain("keeperCount");
    expect(rules.unsupportedForPlayoffOdds).toContain("divisions");
  });

  it("reports missing rules instead of guessing them", () => {
    const rules = parseLeagueRules({ teamCount: 10 });

    expect(rules.playoffTeamCount).toBeNull();
    expect(rules.regularSeasonMatchupPeriods).toBeNull();
    expect(rules.missing).toContain("playoffTeamCount");
  });

  it("survives a malformed blob without throwing", () => {
    expect(() => parseLeagueRules("not an object")).not.toThrow();
    expect(parseLeagueRules(null).teamCount).toBe(0);
    expect(parseLeagueRules({ teamCount: -3 }).teamCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/contracts/src/league-rules.test.ts`
Expected: FAIL — cannot resolve `./league-rules.js`.

- [ ] **Step 3: Implement the parser**

Write `packages/contracts/src/league-rules.ts` with the `LeagueRules` interface above and a
`parseLeagueRules` that reads defensively: an `objectValue` guard, an integer-in-range guard, and a
`missing` accumulator. Validate ISO timestamps, integer ranges, bounded arrays, and unique division
IDs. `teamCount` becomes `0` when absent or non-positive and is also listed in `missing`. Re-export
from a domain module through `packages/contracts/src/index.ts`; do not add another large inline
contract block to the existing barrel.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/contracts/src/league-rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Record the completed checkpoint in this plan.**

#### Task 1.2: Replace Schedule Edge's ad-hoc settings reads

- [ ] **Step 1: Read the current implementation**

`apps/api/src/schedule-edge.ts:789-791` extracts `regularSeasonMatchupPeriods` and
`playoffMatchupPeriodLength` with local helpers.

- [ ] **Step 2: Run the existing Schedule Edge tests to establish a green baseline**

Run: `npx vitest run apps/api/src/schedule-edge.test.ts`
Expected: PASS. Record the count.

- [ ] **Step 3: Swap in `parseLeagueRules`**

Replace the local extraction with `parseLeagueRules(settings)`. Keep the surrounding playoff-window
behavior identical — this is a refactor, not a behavior change.

- [ ] **Step 4: Re-run the Schedule Edge tests**

Run: `npx vitest run apps/api/src/schedule-edge.test.ts`
Expected: PASS with the same count. Any change means the refactor altered behavior; fix it.

- [ ] **Step 5: Record the completed checkpoint in this plan.**

#### Task 1.3: Playoff-odds assembly

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/playoff-odds.test.ts
import { describe, expect, it } from "vitest";

import { buildPlayoffOddsInput } from "./playoff-odds.js";

const rows = [
  {
    snapshotId: "snapshot-1",
    effectiveAt: "2026-09-08T12:00:00.000Z",
    week: 1,
    status: "final" as const,
    homeTeamId: "a",
    awayTeamId: "b",
    homeScore: 110,
    awayScore: 99,
  },
  {
    snapshotId: "snapshot-1",
    effectiveAt: "2026-09-08T12:00:00.000Z",
    week: 2,
    status: "scheduled" as const,
    homeTeamId: "a",
    awayTeamId: "b",
    homeScore: null,
    awayScore: null,
  },
];

describe("buildPlayoffOddsInput", () => {
  it("treats only unfinished matchups as remaining", () => {
    const assembled = buildPlayoffOddsInput({
      matchups: rows,
      teams: [
        { teamId: "a", wins: 1, losses: 0, ties: 0, pointsFor: 110 },
        { teamId: "b", wins: 0, losses: 1, ties: 0, pointsFor: 99 },
      ],
      playoffTeamCount: 1,
      seed: "league:1:week:2",
    });

    expect(assembled.state).toBe("available");
    if (assembled.state !== "available") throw new Error("Expected available playoff input");
    expect(assembled.input.remainingMatchups).toEqual([{ week: 2, teamAId: "a", teamBId: "b" }]);
    expect(assembled.input.seed).toBe("league:1:week:2");
  });

  it("withholds the simulation when the playoff team count is unknown", () => {
    const assembled = buildPlayoffOddsInput({
      matchups: rows,
      teams: [{ teamId: "a", wins: 1, losses: 0, ties: 0, pointsFor: 110 }],
      playoffTeamCount: null,
      seed: "s",
    });

    expect(assembled).toMatchObject({
      state: "unavailable",
      reasons: expect.arrayContaining(["playoffTeamCount"]),
    });
  });

  it("returns finalized standings when no matchups remain", () => {
    const assembled = buildPlayoffOddsInput({
      matchups: [rows[0]!],
      teams: [
        { teamId: "a", wins: 1, losses: 0, ties: 0, pointsFor: 110 },
        { teamId: "b", wins: 0, losses: 1, ties: 0, pointsFor: 99 },
      ],
      playoffTeamCount: 1,
      seed: "s",
    });

    expect(assembled.state).toBe("complete");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/api/src/playoff-odds.test.ts`
Expected: FAIL — cannot resolve `./playoff-odds.js`.

- [ ] **Step 3: Implement `buildPlayoffOddsInput`**

Return an availability-shaped assembly result rather than an unexplained `null`. Use only the latest
coherent matchup snapshot and reject a partial remaining schedule. Withhold simulation when
`playoffTeamCount` is unknown, fewer than two teams are present, or
`unsupportedForPlayoffOdds` is non-empty. When no matchups remain, return a deterministic finalized
seed/qualification result rather than calling the section unavailable. Prefer a compatible
projection set for each team's future scoring mean and variance. Current points-per-game is an
explicit degraded fallback only after a minimum completed-game sample; preseason or sparse state
without projections is unavailable, not a league-mean guess.

The seed is supplied by the caller so the simulation is reproducible under ADR 0003; derive it in
`league-analytics.ts` from league-season ID, the selected matchup snapshot ID, projection checksum,
rules checksum, and algorithm version.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/api/src/playoff-odds.test.ts`
Expected: PASS.

- [ ] **Step 5: Record the completed checkpoint in this plan.**

#### Task 1.4: Wire playoff odds into the analytics response

- [ ] **Step 1: Write the failing route/service test**

Extend `apps/api/src/league-analytics.test.ts` with a case asserting that a league with remaining
matchups and a known `playoffTeamCount` returns a `playoffOdds` section containing per-team
`playoffProbability`, `seedProbabilities`, and `monteCarloStandardError`; and that a league with an
unknown `playoffTeamCount` returns `playoffOdds` in an `unavailable` state naming the missing rule.
Add cases proving that mixed matchup snapshots, incomplete future schedules, divisions, median
games, and unsupported tiebreakers cannot silently produce generic odds.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/src/league-analytics.test.ts`
Expected: FAIL — no `playoffOdds` in the response.

- [ ] **Step 3: Implement**

In `league-analytics.ts`, parse rules with `parseLeagueRules`, build the input with
`buildPlayoffOddsInput`, call `simulatePlayoffOdds`, and attach the result plus the seed, simulation
count, algorithm version, forecast basis, snapshot identity, input checksum, and warnings to a
domain-specific response contract. Follow the existing availability shape used elsewhere in the
file so an unknown or unsupported rule degrades a section rather than failing the response.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run apps/api/src/league-analytics.test.ts`
Expected: PASS.

- [ ] **Step 5: Record the completed checkpoint in this plan.**

#### Task 1.5: Playoff odds UI

- [ ] **Step 1: Add the section to `league-analytics-workbench.tsx`**

Per-team playoff probability with its Monte Carlo standard error, expected seed, and a seed
distribution. Show the simulation count, forecast basis, rules/snapshot freshness, and algorithm
version in the provenance area. Render unavailable and degraded states with their reasons rather
than hiding the section.

- [ ] **Step 2: Verify mobile at 320, 375, and 430 CSS pixels**

The seed-distribution table scrolls inside its own `overflow-x: auto` container. The page body must
not scroll horizontally.

- [ ] **Step 3: Run the full check suite and record the checkpoint**

```bash
npm run lint && npm run typecheck && npm test
```

#### Task 1.6: Yahoo operational rules — DEFERRED until Yahoo approval (2026-07-27)

Populating `operationalRules` in `packages/connector-yahoo/src/xml.ts` requires knowing what the
league settings resource actually returns for this application. It cannot be verified without an
approved account, and `docs/provider-notes/yahoo.md` is explicit that "the client does not invent
response schemas" and that approved-app contract tests govern the real response.

A normalizer written against guessed field names, tested against a fixture authored from the same
guesses, proves only that the parser matches the guess. One concrete mismatch is already visible
without a real response: Yahoo documents `trade_end_date` as a bare calendar date, while
`parseLeagueRules` validates `tradeDeadlineAt` as an ISO datetime with an offset. Whether that needs
a converter, a timezone assumption, or a schema change is not answerable from the guide alone.

**Nothing else in WP1 depends on this.** ESPN already populates `operationalRules`, so the parser,
Schedule Edge, and playoff odds all work today. Yahoo leagues will simply report those rules in
`missing` until this lands, which is the correct honest behavior.

Resume this as part of step 6 of the `docs/provider-notes/yahoo.md` setup checklist — capture
sanitized fixtures from the approved account, then write the normalizer against them.

### Exit criteria

- Every stored league rule is read through one validated parser; no surface reaches into
  `league_seasons.settings` directly.
- An absent rule is reported, never defaulted.
- Playoff odds are reproducible: same league state and seed produce identical output.
- A league with an unknown playoff team count degrades that section only.
- A league using an unsupported division, median-game, seeding, or tiebreaker rule is withheld with
  the exact reason; generic standings logic is never presented as provider-faithful.
- Only one coherent matchup snapshot feeds a simulation, and an incomplete remaining schedule is
  never treated as complete.
- Forecast basis and model uncertainty are distinct from Monte Carlo sampling error in both the
  response and UI.
- Schedule Edge behavior is unchanged by the refactor.

---

## WP2 — Draft analyzer integration (B6)

**Status: complete (2026-07-27).** Three honest data limits are reported by the feature rather than
worked around: the admitted ADP source publishes no auction value, no tier source exists, and no
`full-season` horizon producer exists, so `projections` reports `NO_COMPATIBLE_SET` for every
league until WP9 admits a draft-timed artifact.

### Why it is ready

`packages/engine-draft/src/analyzer.ts` is complete and tested, with **zero references** anywhere in
`apps/`. Critically, `DraftAnalyzerInput` marks both `market` and `projections` **optional**
(`analyzer.ts:62-70`), so it degrades honestly with neither. `GET /v1/drafts/:draftId/market`
(`apps/api/src/draft-routes.ts:213`) already serves an admitted FFC ADP market, and
`DraftSessionSnapshot` already carries `config: DraftConfig` and an event list
(`apps/api/src/draft-session.ts:468-482`).

### Files

- Create: `apps/api/src/draft-analysis.ts` — snapshot to `DraftAnalyzerInput` mapping and assembly
- Create: `apps/api/src/draft-analysis.test.ts`
- Modify: `apps/api/src/draft-routes.ts` — add `GET /v1/drafts/:draftId/analysis`
- Modify: `apps/api/src/draft-routes.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/src/components/draft-analysis-panel.tsx` and its module CSS
- Modify: the Draft Studio component that owns post-draft views

### Interfaces

**Consumes:** `analyzeDraft` from `@fantasy/engine-draft`; `DraftSessionSnapshot` from
`apps/api/src/draft-session.ts`.

**Produces:** `GET /v1/drafts/:draftId/analysis` returning reach/value and roster construction for
snake, price/value and budget efficiency for auction, per-team projections when a compatible
projection set exists, and an explicit warning list when it does not.

### Steps

- [x] **Task 2.1** — Map `DraftSessionEventRecord[]` to the analyzer's `DraftEvent[]`. Write the
      mapping test first; the two types are near-identical but confirm rather than assume, and fail
      loudly on an event kind the analyzer does not model.
- [x] **Task 2.2** — Assemble `DraftAnalyzerInput`, passing `market` from the existing market read
      and omitting `projections` when no compatible set exists. Test the no-projection path
      explicitly: it must produce roster construction and ADP-relative reach/value, and a warning
      naming the missing projection set — not an error. Projection compatibility includes season,
      league scoring profile, draft timing, freshness, and horizon; “latest row” alone is not a
      compatibility policy.
- [x] **Task 2.3** — Add the authenticated route with the same membership authorization and `404`
      shape used by the other draft routes. Test that a non-member receives the unknown-draft `404`.
- [x] **Task 2.4** — Draft Studio panel. Snake and auction views are visually distinct, per the fixed
      decision that auction is a first-class workflow. The analyzer updates from partial event state
      during a live or manual draft and becomes a final report when the draft completes. Verify at
      320, 375, and 430 CSS pixels.

### Exit criteria

- Analysis renders for a completed draft with no projection set, with a visible reason.
- Partial-draft analysis updates without being mislabeled as a final grade.
- Snake and auction drafts each render their own analysis shape.
- A non-member cannot read another league's draft analysis.
- No claim of projection-derived value appears when projections are absent.

---

## WP3 — Trade builder and conditional multi-horizon valuation (D4 remainder, D5)

### Why it is ready

`evaluateTrade` accepts arbitrary `sendsFromA` / `sendsFromB`
(`packages/engine-trade/src/index.ts:30-40`) and already returns forced drops, legality diagnostics,
fairness gap, and mutual benefit. Generation and the profitable/fair views already ship. The only
gap is that `apps/api/src/in-season-decision-routes.ts` exposes exactly one route — `GET
/v1/leagues/:leagueId/decisions` — so a user cannot evaluate a package they constructed themselves.

`EvaluateTradeInput.horizons` already accepts multiple weighted horizons. The admitted ROS release
path means this is no longer globally blocked: a league with a compatible published ROS set can
blend weekly and ROS value, while any other league remains weekly-only with a stated reason. WP9
expands scoring-profile coverage and makes those release reasons legible.

### Files

- Modify: `apps/api/src/in-season-decision-routes.ts` — add the builder route
- Modify: `apps/api/src/in-season-decision-routes.test.ts`
- Modify: `apps/api/src/in-season-decisions.ts` — extract a reusable single-package evaluation path
- Modify: `apps/api/src/in-season-decisions.test.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/web/src/lib/api-client.ts`
- Modify: `apps/web/src/components/decision-workbench.tsx` and its module CSS

### Interfaces

```
POST /v1/leagues/:leagueId/trade-evaluations
  body: { opponentTeamId: string, sendsPlayerIds: string[], receivesPlayerIds: string[] }
```

Requires authentication and league membership. Unknown and inaccessible leagues both return `404`.
Bound the request: at most four players per side, all of which must belong to the claimed roster and
the named opponent's roster respectively. Reject duplicate IDs, empty sides, players on both sides,
unknown fields, and oversized bodies. Model-supplied and client-supplied IDs are untrusted input.

### Steps

- [x] **Task 3.1** — Extract the per-package evaluation from the generation loop
      (`in-season-decisions.ts:1510-1545`) into a function both the generator and the builder call.
      Assert the existing decision snapshot output is byte-identical before and after.
      **Done.** `evaluateTradePackage(context, tradePackage)` plus a `#loadDecisionFacts` extraction
      that both `getSnapshot` and `evaluateBuiltTrade` consume. Byte identity is proven by a frozen
      SHA-256 fingerprint of the serialized snapshot, captured before the first refactor and never
      edited since.
- [x] **Task 3.2** — Add the route with membership authorization and input bounds. Test: a player not
      on either roster is rejected; more than four per side is rejected; a nonmember gets the same
      `404` as an unknown league; a package with no legal forced drop returns the
      `NO_LEGAL_FORCED_DROP` diagnostic rather than an error.
      **Done.** `POST /v1/leagues/:leagueId/trade-evaluations`, `bodyLimit: 4096`. Both roster-
      membership failures share one indistinguishable `problems/trade-package-invalid` `400` whose
      `detail` names no player, team, or roster fact.
- [x] **Task 3.3** — Builder UI in Decision Desk. Reuse the existing package presentation from
      `mapTradePackage` so a built package and a suggested package read identically.
      **Done.** A legal built package renders through the same `TradeCard` the generated packages
      use. Roster options come from the existing `/dashboard` read, so the route exposes no roster
      fact the member could not already see.
- [~] **Task 3.4** — Select horizons server-side. When a fresh, scoring-compatible ROS set exists,
  blend the documented weekly and ROS weights and retain both source checksums. Otherwise use
  weekly value only and return a structured `rosUnavailable` reason. Never substitute a
  scoring-incompatible ROS set.
  **Seam shipped, blocked on WP9.** `resolveTradeHorizons` blends a rest-of-season horizon when a
  compatible admitted release is supplied and falls back to weekly-only otherwise; both arms are
  unit tested. No ROS release can be selected until WP9 exposes scoring-profile coverage, so
  every evaluation is weekly-only today and says so through a non-null `rosUnavailable` reason.
  The blend weight travels with the admitted release rather than being invented here, because no
  weekly/ROS weighting policy is documented anywhere yet.
- [ ] **Task 3.5** — Add trade-value history/chart output only after at least two compatible
      immutable observations exist. A single point is labeled current value, not a trend.
      **Outstanding.** Still blocked; no compatible immutable observations exist.

### Exit criteria

- A user-constructed package returns the same evaluation shape as a generated one.
- Roster legality and forced drops are enforced server-side; the client cannot bypass them.
- No other member's roster is exposed by the new route.
- Multi-horizon valuation appears only when every included horizon is compatible and fresh.
- Weekly-only evaluation remains fully usable and explicitly says why ROS was not included.

---

## WP4 — Provider-aware sync and recommendation orchestration (A1)

### Why it is ready

`LeagueSyncService` and `RecommendationRecomputeService` interfaces are declared at
`apps/worker/src/jobs.ts:92-102` and accepted as optional members of `WorkerServices` (`:123-131`).
`apps/worker/src/worker.ts:98-100` supplies only `dataHealth`, `notificationSweep`, and
`projectionRefresh`. Both queues, their dead-letter queues, dispatch options, and singleton keys
already exist (`jobs.ts:5-16,259-292`).

The providers do not share one refresh capability. ESPN credentials stay in Chrome, so the server
cannot initiate an ESPN read; accepted bridge snapshots are the sync event and should enqueue
downstream work. A provider with server-refreshable credentials may use the worker sync queue.
Treating ESPN's lack of server credentials as a failed background job would be both noisy and
incorrect.

### Steps

- [x] **Task 4.1** — Extract provider-neutral recomputation and any server-refreshable sync service
      into a package shared by API and worker. Neither app imports the other. `@fantasy/jobs` (queue
      contract), `@fantasy/league-sync` (Yahoo sync + connection circuit), and `@fantasy/decisions`
      (in-season decision core + recommendation runs). `eslint.config.mjs` now fails the build on a
      cross-app import.
- [x] **Task 4.2** — Implement
      `RecommendationRecomputeService.recomputeRecommendations`, scoped to the affected league and
      recommendation kinds. Persist through `recommendation_runs`/`recommendations` with algorithm
      version, input checksum, source freshness, warnings, and idempotent replay. Reject an unknown
      kind rather than silently ignoring it.
- [x] **Task 4.3** — Enqueue downstream recomputation after successful existing provider ingestion:
      accepted ESPN bridge snapshot/supplemental data and successful server-side provider sync. A
      duplicate provider payload must not create a duplicate recommendation run.
- [x] **Task 4.4** — Implement `LeagueSyncService.syncLeague` only for a connection capability that
      supports server-initiated refresh. For ESPN, return a typed
      `external-companion-required` no-op state rather than attempting a read or dead-lettering.
      Honor `league-sync:${connectionId}:${leagueSeasonId}` for supported providers and test
      idempotent replay, cancellation, and credential expiry.
- [x] **Task 4.5** — Register the services in `worker.ts`. A retryable provider failure reaches the
      provider/connection-specific dead-letter path with bounded retries and cannot stop unrelated
      sources or recomputation.

### Exit criteria

- A queued sync performs a real refresh only for a server-refreshable provider; ESPN is never
  fetched without the companion.
- A successful provider ingestion produces a real, idempotent downstream recomputation.
- Overlapping jobs for one league serialize.
- Repeated failure opens a provider/connection-scoped circuit breaker without affecting other
  analysis.
- Recommendation runs retain algorithm version, input checksum, freshness, and warnings.

**For WP5:** `recommendation_runs` now has a real producer and a stable replay identity to diff
against — `(league_season_id, fantasy_team_id, kind, algorithm_version, input_hash)`, unique with
`NULLS NOT DISTINCT` as of migration `0026`. `packages/contracts/src/recommendation-runs.ts` types
the persisted `inputs` bundle and its provenance. Every run is computed from league-visible
projection sets only and records `PRIVATE_PROJECTION_SETS_EXCLUDED`, so a run is safe to surface
league-wide; it will legitimately differ from what a user holding a private projection set sees on
demand, and WP5 owns that explanation. There is deliberately no read route yet.

---

## WP5 — Change events (A6, D9)

### Why it is ready

The schema is fully designed and completely unused. `change_events`
(`packages/db/src/schema.ts:2631-2667`) has a source/deduplication unique index, `visibility`
(`private` | `league` | `global`), `severity` (`info` | `action` | `warning` | `critical`), a
league/actor scope, and a JSONB payload. `change_event_receipts` (`:2669-2700`) has per-user
delivered/first-seen/read/dismissed timestamps, delivery channels, a partial unread index, and check
constraints. Nothing in `apps/api` or `apps/web` references either table.

### Steps

- [x] **Task 5.1** — Define a versioned event-kind registry and bounded payload schemas before
      writing rows. Reads parse the registered version and degrade unknown legacy versions safely.
- [x] **Task 5.2** — A transactional writer that emits deduplicated events. Deduplication identifies
      the source transition or material input/output checksum, not merely the player and status, so
      a later recurrence such as healthy → questionable is not suppressed forever. Test idempotent
      replay and a legitimate repeated transition.
- [x] **Task 5.3** — Emit from real producers: completed league sync/ingestion (WP4), roster change, injury
      status change, and a material recommendation delta. Compare against the prior run rather than
      emitting on every write.
- [x] **Task 5.4** — Resolve recipients explicitly. Roster- and opponent-specific events are private
      to affected users; league events reach current members; global source-health events expose no
      private league payload.
- [x] **Task 5.5** — An authorized cursor-paginated read route returning a bounded event window and
      unread count with visibility enforced server-side. A `private` event must never reach another
      user; a `league` event reaches only current members.
- [x] **Task 5.6** — Idempotent read and dismiss endpoints honoring the `first_seen_at` constraints,
      plus a documented retention/pruning policy that never resurrects dismissed events.
- [x] **Task 5.7** — Dashboard surface with read/dismiss state, prioritized by severity. Reuse the
      existing push preferences for the small subset of actionable events that merit a notification;
      do not notify for every informational change.

### Exit criteria

- No duplicate alerts for one underlying change.
- A later genuine recurrence of the same event kind is not swallowed by deduplication.
- Cross-user and cross-league isolation tests pass for every new path.
- Dismissing an event persists and does not resurrect on the next sync.
- Event feeds are cursor-paginated, bounded, versioned, and covered by retention.

---

## WP6 — Unresolved identity observability (A5)

### Why it is ready

The data exists. `player_weekly_stat_observations` and `player_weekly_roster_observations` both carry
a nullable `player_id` with a dedicated unmatched partial index
(`packages/db/src/schema.ts:1819,1941`). Ingestion already reports rows read, written, rejected, and
unmatched in source quality metadata, and `apps/worker/src/data-health.ts:40-63` already derives a
degraded state from `qualityState`. These immutable unresolved rows are not a mutable quarantine
queue; this package makes their impact visible without implying that a member should repair source
data.

### Steps

- [x] **Task 6.1** — An operator-only bounded read returning unmatched-record counts by source,
      season, and week, plus a capped/redacted sample of unresolved identities. Bound the response,
      fields, and query window explicitly.
- [x] **Task 6.2** — A member-safe summary returning only affected analysis state, match rate,
      freshness, and reason. It must not expose raw unresolved source rows or another league's
      context.
- [x] **Task 6.3** — Reuse each source's existing admission threshold where one exists; define a
      threshold only for sources without one. Prove the threshold participates in the affected
      calculation's admission decision rather than merely changing a health badge.
- [x] **Task 6.4** — Put operator detail in Data Health. Show only the member-safe degraded summary
      in League Sync and affected analysis surfaces.

### Exit criteria

- An unresolved identity is visible to the operator with its source and week, never silently
  guessed.
- A source below its match-rate threshold is visibly degraded.
- The read is bounded and cannot enumerate the full observation tables.
- Ordinary members see impact and remediation status without receiving raw source diagnostics.

---

## WP7 — Typed deterministic AI tools (E1)

### Why it is ready

Every deterministic output the tools need now exists: Decision Desk (lineup, waivers, trades),
Schedule Edge, League Analytics including playoff odds after WP1, Stats Center, and draft advice.
`apps/api/src/ai-service.ts` currently sends one bounded context payload to a completion adapter;
`apps/api/src/ai-provider-adapters.ts` contains no tool-calling support at all.

This is the largest package. It runs last because each tool wraps a surface the earlier packages
finish.

### Constraints (from `ENHANCEMENT_PLAN.md` §2.5, non-negotiable)

- Every tool call performs server-side membership authorization and returns bounded structured data.
  Model-supplied IDs are untrusted input.
- Enforce per-request limits for model turns, tool calls, tokens, and wall time, plus the managed
  daily budget. Count and reserve each model invocation in a multi-turn tool loop, not merely the
  original feature request. Quota exhaustion falls back to the deterministic result and never
  blocks core features.
- Cache keys include user, league, feature, model/provider, prompt version, tool-contract version,
  and data checksum. Never share private context across users.
- Imported news, notes, league names, and user text are untrusted content that cannot alter tool
  permissions or system rules.
- The deterministic answer remains available without AI.

### Steps

- [ ] **Task 7.1** — Tool contract type and registry, versioned. One tool, end to end, first:
      `get_lineup_recommendation`.
- [ ] **Task 7.2** — Gemini function-calling support in the managed adapter, then BYOK adapters, with
      a capability matrix so an adapter whose model lacks tool use degrades clearly.
- [ ] **Task 7.3** — Bounded orchestration loop with turn, call, token, and wall-time limits.
- [ ] **Task 7.4** — Remaining tools: comparison, waivers, trades, playoff simulation, player stats,
      draft advice.
- [ ] **Task 7.5** — Golden scenarios for start/sit, no-worthy-waiver, fair/profitable trade,
      playoff, and draft advice. Evaluate factual grounding and action consistency, not writing style.

### Exit criteria

- A tool call cannot cross a user or league boundary, including with a model-supplied ID.
- Budget exhaustion returns the deterministic result.
- No tool can mutate provider state.
- Golden scenarios pass in the repository's automated test suite. This package does not add a
  GitHub Actions workflow.

---

## WP8 — Sleeper provider notes

Sleeper is in production today — `packages/source-sleeper/src/sleeper-source.ts` supplies the player
catalog and hourly add/drop trends to every user regardless of provider — but `docs/provider-notes/`
contains `espn.md` and `yahoo.md` and no `sleeper.md`. Under `ENHANCEMENT_PLAN.md` §2.1, the terms,
attribution, rate limits, supported coverage, and match-rate thresholds for a shipped source must be
documented.

- [ ] **Step 1: Recheck Sleeper's current published terms and rate limits.** Do not rely on this
      plan's summary; §2.1 requires a live check.
- [ ] **Step 2: Write `docs/provider-notes/sleeper.md`** covering the endpoints actually in use
      (`/v1/players/nfl`, `/v1/players/nfl/trending`), the documented call ceiling already encoded as
      `SLEEPER_DOCUMENTED_CALLS_PER_MINUTE`, attribution strings already defined as
      `SLEEPER_ATTRIBUTION` and `SLEEPER_ATTRIBUTION_URL`, response bounds, identity match coverage,
      and the freshness and kill-switch behavior.
- [ ] **Step 3: Record that league connection is deferred** by the 2026-07-27 product decision, and
      that the league source in `packages/source-sleeper/src/sleeper-league-source.ts` is built but
      intentionally unwired.
- [ ] **Step 4: Verify the attribution is rendered** wherever Sleeper trend data appears.
- [ ] **Step 5: Record the completed checkpoint.**

---

## WP9 — ROS release observability and common scoring-profile coverage (C3)

### Why it is ready

The production release rail, league-scoped projection-set persistence, and evidence-ready v8
artifact are implemented. The latest admitted artifact covers one exact standard full-PPR scoring
profile. The legacy shadow audit still records deliberately degraded diagnostics and uses names such
as `first-party-ros-shadow`; those rows are useful for audit history but are not the authoritative
answer to “can this league receive ROS projections?” Conflating the two already caused an incorrect
conclusion that all ROS publication remained disabled.

### Steps

- [ ] **Task 9.0 — Fix the live scenario-count persistence contract before claiming production
      readiness.** The engine's standard release projection uses 12,288 paths and its reference run
      uses 16,384, but `player_ros_projection_summaries`, its insert trigger, and
      `buildFirstPartyRosPlayerPersistenceRow` currently cap a persisted live summary at 4,096.
      Meanwhile the production candidate provider does not override the engine default, so the first
      otherwise releasable 12,288-path league projection would fail during persistence. Resolve this
      with one forward migration and one shared contract: persist the 12,288-path release result,
      admit its 16,384-path convergence reference, import the engine constants rather than copying
      numeric caps, reuse the already-computed 12,288-path candidate when comparing it with the
      reference, and retain all existing interval/calibration checks. Add a PostgreSQL integration
      test that exercises the real default candidate-to-publication path; the existing fake-provider
      tests with 256 scenarios do not cover this mismatch. Benchmark the real path against the worker
      job timeout before shipping.
- [ ] **Task 9.1** — Define one typed ROS release-status contract with separate fields for:
      admitted artifact state, supported scoring-profile identity, league input readiness, live
      per-cell gate decisions, latest published league set, and the independent shadow-audit state.
      Never collapse those into one red/green status.
- [ ] **Task 9.2** — Make the API return structured per-league withholding reasons such as no
      admitted scoring profile, incomplete schedule, missing roster snapshot, insufficient candidate
      inputs, non-converged cell, stale source, or no league synced. Do not infer global release state
      from the latest shadow model run.
- [ ] **Task 9.3** — Update Projection Lab/Data Health copy and provenance so an admitted,
      release-capable artifact cannot be presented as globally shadow-only. Show the latest retained
      good set when a new cell is withheld.
- [ ] **Task 9.4** — Run the frozen v8 validation/admission process independently for common
      standard and half-PPR profiles, in addition to the admitted full-PPR profile. Each artifact
      keeps its own scoring fingerprint, evidence report, checksum, and admission record. Do not
      relax a gate to make a profile pass; a failed profile remains unsupported with its evidence.
- [ ] **Task 9.5** — Add regression tests for exact scoring-profile selection, no cross-profile
      fallback, mixed releasing/withheld cells, retained last-good output, and status rendering.
- [ ] **Task 9.6** — Update `ENHANCEMENT_PLAN.md`, operations documentation, and Projection Lab
      terminology after the status contract lands.

### Exit criteria

- A user can tell whether ROS is globally validated, supported for their scoring profile, ready for
  their league inputs, and actually published without reading internal model-run JSON.
- Shadow-audit degradation never implies that an admitted production artifact is globally disabled.
- A default 12,288-path release projection persists successfully with a valid 16,384-path
  convergence reference; an out-of-contract count still fails closed.
- Full-, half-, and non-PPR artifacts are admitted only if each independently clears the unchanged
  evidence gates.
- No league ever receives an ROS set scored under a merely similar profile.

---

## WP10 — Public methodology and validation receipts

### Goal

Give the landing page's strongest proof claims a concise, credible public receipt without turning
the marketing page into model documentation.

### Public surface

- Add an unauthenticated `/methodology` page matching the established Laces Out visual system.
- Explain weekly forecasts and ROS forecasts separately so evidence for one is never implied to
  prove the other.
- For the current official ROS replay, disclose:
  - the four held-out NFL seasons;
  - 2,040 forecasts graded against realized outcomes;
  - 12,288 deterministic simulation paths per release projection;
  - the evaluation/admission date, model and policy versions, artifact checksum, and scoring profile;
  - the release-gate categories and whether any blockers remained;
  - important limitations, unsupported scoring profiles, and the meaning of a withheld result.
- Summarize weekly-model validation from its own checked-in evidence and label its sample, seasons,
  metrics, and release gates independently.
- Link to a concise machine-readable, versioned evidence manifest or checked-in report summary from
  which every displayed number is derived. Do not expose credentials, internal paths, raw private
  league data, or operational controls.

### Landing-page constraint

Do **not** reword, shorten, reorder, or restyle the existing stat-strip claims:

- `4 backtested NFL seasons`
- `2K+ predictions graded against reality`
- `12K+ simulations per projection`
- `If it isn’t proven, it isn’t published`

Make the strip, or preferably the final “If it isn’t proven…” statement, a clear accessible link to
`/methodology`. Add a normal Methodology link in the footer. Those links are the only stat-strip
change authorized by this package.

### Steps

- [ ] **Task 10.1** — Create a small versioned evidence manifest derived from the official checked-in
      validation reports. Tests assert the exact seasons, forecast count, scenario count, versions,
      checksum, and blocker state so page copy cannot drift from its evidence. This task starts only
      after WP9 Task 9.0 makes the live persistence contract agree with the 12,288-path claim.
- [ ] **Task 10.2** — Build the public page with a short executive explanation first, evidence tables
      second, and limitations/provenance last. Keep technical detail available without requiring a
      visitor to understand internal rail terminology.
- [ ] **Task 10.3** — Link the unchanged landing stat strip and footer to the page. Preserve the
      existing words and visual hierarchy.
- [ ] **Task 10.4** — Add metadata, canonical URL, keyboard/focus behavior, responsive layouts, and a
      signed-out route test. Verify at 320, 375, and 430 CSS pixels.
- [ ] **Task 10.5** — Add a regression test that fails if a displayed proof number is not sourced
      from the evidence manifest.

### Exit criteria

- Every public numeric proof claim has a visible source, version, scope, and limitation.
- The page clearly distinguishes weekly-model evidence from ROS-model evidence.
- The landing stat strip is textually and visually unchanged except for its link behavior.
- `/methodology` works without registration or authentication.

---

## 10.5 Defects discovered during execution (2026-07-27)

Found while executing this plan, outside its original scope. Recorded here so they are not lost.

**FIXED — ROS release could never persist, for two independent reasons.** WP9 Task 9.0 was scoped to
the scenario-count mismatch: the engine's release run uses 12,288 paths and its convergence reference
16,384, while the summaries table, its insert trigger, and the publication path all capped a persisted
summary at 4,096, and the production candidate provider passes no override. Migration
`0025_ros_scenario_contract.sql` widens the bound to the engine's own
`FIRST_PARTY_ROS_MINIMUM_SCENARIOS`..`FIRST_PARTY_ROS_MAXIMUM_SCENARIOS` and all four call sites now
import those constants instead of copying literals — the duplicated literal was the root cause, and
re-copying a larger one would only have rescheduled the bug.

Fixing that exposed a second, independent blocker: PostgreSQL `jsonb` does not preserve object key
order, and three evidence-identity comparisons used order-sensitive `JSON.stringify`. Every
database-loaded champion policy therefore failed with `evidence-identity-mismatch`. Either defect
alone was sufficient to prevent any ROS release from ever persisting, and neither was visible to the
existing fake-provider tests, which run at 256 scenarios. Fixed by canonicalizing the evidence
identity to its declared field order; no threshold was changed and all existing checksums reproduce
byte-for-byte.

**NEEDS OPERATIONAL ATTENTION — ROS publication throughput. The widely-quoted 4.77 s figure is not a
measurement; do not cite it.** It was a two-point hand fit over 4- and 8-player runs of
`first-party-ros-scenario-contract.pg.test.ts`, where the 8-player run required a since-reverted edit
to `ROSTERED_WR_COUNT`. It is not reproducible from the committed file.

Revised estimate from a later review: **6.7–7.8 s per player at a ten-week horizon (~230–270 players
per job), 10–12 s at eighteen weeks (~150–180)**, with roughly ±2× contention uncertainty. About
75% of the cost is the 12,288-path Monte Carlo, which is history-independent; the growth comes from
assembly, where `weightedComponentMean` (`packages/projections/src/first-party.ts`) does one uncached
linear scan that grows super-linearly with feature breadth.

Three further risks, none yet settled:

- **1,800 s is not the ROS budget.** The same job first runs the weekly data refreshes and the full
  weekly `refreshProjections` — itself a production-scale backtest — before ROS starts. ROS gets
  whatever remains, and that remainder has never been measured.
- **Three profiles cost strictly 3×.** Nothing is cached across artifacts; each redoes all bulk reads,
  history build, backtest, and all three calibrations. The scoring profile is applied inside every
  simulated path, so there is no cheap per-profile re-projection, and the RNG seed is per league, so
  two leagues on the same profile re-simulate the same player independently.
- **No batching or resume in the publish path.** All targets are built in memory before any
  persistence, so a job that expires mid-run loses the whole slice, and the retry then collides on the
  sync-run idempotency key and no-ops.

**BLOCKING AND NOT A CODE DEFECT — the production database has no leagues.** A direct read on
2026-07-27 returned `leagues: 0`, `league_seasons: 0`, `scoring_rules: 0`, against `players: 18,972`,
`player_weekly_stat_observations: 75,788`, and `data_sources: 44`. The shared NFL data rail is
healthy and populated; no league has ever been synced. This is why the publication path builds no
targets, and it was briefly misdiagnosed as a scoring-key matching defect. Whether a real league's
normalized profile matches one of the three canonical ROS keys — exact full-JSON equality, no
widening (`first-party-ros-candidate-provider.ts:146`) — is untested and untestable until a league
exists. Sync one before drawing any conclusion about profile coverage.

**FIXED — Sleeper player-catalog size bound.** A live check measured the catalog at 14,609,548 bytes
across 12,201 rows against a 16 MiB `MAX_PLAYER_RESPONSE_BYTES`. At 87% of the bound, ordinary roster
churn would have tripped `SleeperSourceError("TOO_LARGE")` mid-season and staled the entire player
catalog — which feeds every user regardless of provider. Raised to 32 MiB in
`packages/source-sleeper/src/sleeper-source.ts`, with the measurement recorded in a comment.

**RESOLVED — Sleeper catalog refresh cadence.** `catalogCheckIntervalMinutes` was 30
(`apps/worker/src/sleeper-data.ts:25`), while Sleeper's documentation asks callers to fetch the
players endpoint at most once per day and cache it locally. Lowered to **60** by product decision on
2026-07-27, halving the request rate. It is still more frequent than the documented guidance and
must not be described as compliant with it; `docs/provider-notes/sleeper.md` keeps that as an open
admission item. The mitigation is real — the endpoint returns a weak `ETag` and a replay with
`If-None-Match` returns `304` — but note that during an active lineup-lock window the forced final
pass bypasses `nextCheckAt`, so 60 minutes is a floor for ordinary operation rather than a hard
ceiling.

**FEEDS WP6 — no match-rate metadata from the Sleeper sources.** Neither Sleeper source writes
`matchRate` or `rowsUnmatched` into source metadata, so no match-rate gate can be enforced for them.

**RESOLVED IN WP4 — the hand-copied queue config drift is gone.**
`apps/api/src/server.ts:166-173` hand-copies pg-boss queue configuration because the API and worker
share no queue contract, and that copy is already missing `deadLetter` and retention settings that
the worker's own registration sets. API-dispatched jobs therefore do not get the dead-letter and
retention behavior section 2.4 requires. `apps/worker/src/lineup-lock-alerts.ts:272-280` duplicates
logic for the same reason, with the comment "the worker cannot import from the API process." WP4's
`@fantasy/jobs` extraction fixed the root cause: `registerQueues` is the only way to declare a queue
and the `enqueue*` helpers are the only way to produce a singleton key, and
`packages/jobs/src/queue-contract-boundary.test.ts` fails the build if any file under `apps/api/src`
or `apps/worker/src` restates a pg-boss queue setting or singleton key again.

**FEEDS WP6 — `qualityState` is never written as anything but publishable.** `data-health.ts:40`
derives a degraded state from `metadata.qualityState`, but nflverse and FFC ingestion only ever write
`publishable`, so a below-threshold source is invisible to the health job today. The existing
`minimumPublishableMatchRate = 0.95` is duplicated at `apps/worker/src/nflverse-weekly-data.ts:57`
and `apps/worker/src/ffc-adp.ts:27`; WP6 extends that rather than adding a second threshold.

---

## 10.6 Decisions taken during execution (2026-07-27)

Answers to questions the package expansions raised. Recorded so an executor does not relitigate them.

**WP1 Task 1.6 — deferred until Yahoo approval.** See the task itself for the reasoning; nothing else
in WP1 depends on it.

**WP3 — an off-roster player is `400` with one indistinguishable code.** Not a `200` diagnostic, so
the endpoint cannot be used to probe which players sit on which roster. This costs little in
practice: `/dashboard` already returns every team's roster to league members, so the endpoint is not
the boundary that protects roster contents — but an endpoint that answers differently for "not on
that roster" than for "malformed" is a probing oracle regardless, and the indistinguishable form is
also simpler.

**WP4 — recommendation runs are write-only until WP5 consumes them.** The expansion established that
recommendations are computed on demand with `cache-control: no-store` and no persisted output, so
`recommendation-recompute` must compute and persist rather than invalidate a cache. The persisted
run stays unexposed until WP5's change-event feed has a reason to read it. Do not add a read route
in WP4 for a surface with no consumer.

**WP6 — the snap-count match-rate threshold is 0.90**, against 0.95 for the others, because
PFR-keyed snap identities are structurally lossier. It ships with an auditable live-rate check so the
number is evidenced rather than asserted.

**WP5 — one digest per sweep, not one push per event.** Section 2.4 requires deduplicated,
user-relevant events without duplicate alerts, and D9 describes a prioritized feed with read/dismiss
state rather than a firehose. Roster, injury, and recommendation deltas across a twelve-team league
would be noisy per-event, and the fixed product decisions warn against clutter. Severity ordering
happens inside the digest. Immediate send for `critical` is available later without a schema change —
do not build it until something actually needs it.

**WP5 Task 5.8 — sequence the recommendation-delta probe after WP4 Task 4.12, not in the API request
path.** Probing for a delta on a user-facing read would put engine computation in the request path.
WP4 already persists a recommendation run, and this is the consumer that decision anticipated. The
other twelve WP5 tasks do not depend on it and can proceed first.

**WP7 — the managed AI daily budget is 50, and section 0 was right.** Managed reads
`MANAGED_AI_DAILY_REQUEST_LIMIT` (default 50, `packages/config/src/index.ts:19`). The `25` in
`AI_PROVIDER_DEFAULTS` is a display value for providers the member cannot use, not an enforced
managed limit. No contradiction to fix.

**WP7 prerequisite — add an `algorithm` provenance block to the decisions and analytics contracts
before WP7 starts.** Neither contract exposes `algorithmVersion` or `inputChecksum`, so four planned
tools could not satisfy ADR 0003. Shipping them with `null` and a warning would let the AI surface
present recommendations with less provenance than the deterministic surfaces already carry. Schedule
Edge's existing `algorithm` block is the template, and WP1 adds the same shape for playoff odds.
This is independently required by ADR 0003, so it belongs to the owning packages rather than to WP7 —
fold it into WP3 (decisions) and WP1 (analytics) rather than treating it as AI work.

---

## 11. Deferred decisions

These need a product call before they can be planned. They are not blockers for WP0–WP10.

**D7 — fantasy points allowed in Stats Center.** Schedule Edge now computes validated, league-scored,
opponent-adjusted fantasy points allowed, while `apps/api/src/stats-center.ts:818,905` still returns
a hardcoded `unavailable` for the same metric. The obstacle is scoping: `/v1/stats/players` is not
league-scoped, and its `scoring` filter is a fixed `standard | ppr` enum
(`apps/api/src/stats-center-routes.ts:47`). Options are to add an optional `leagueId` to the stats
route and serve league-scored fantasy points allowed when supplied, or to publish the metric under
the two fixed profiles only. The first is more useful and matches `ENHANCEMENT_PLAN.md` D7's wording
that Stats Center use "the same validated FPA definition used by Schedule Edge." Either way, one
definition serves both surfaces — do not fork it.

---

## 12. Cross-cutting testing

Applies to every package, in addition to each package's own exit criteria.

- **Authorization:** every new read, route, and tool has a membership test and an
  indistinguishable-unknown/inaccessible-league test.
- **Determinism:** identical inputs produce identical outputs; reordering equivalent input rows
  changes nothing. Seeded simulations reproduce exactly.
- **Degradation:** missing, stale, unresolved, oversized, and malformed inputs degrade one section
  with a stated reason rather than failing a whole response.
- **Web states:** real, loading, empty, stale, degraded, error, and demo. No sign-in requirement for
  demo content.
- **Mobile:** 320, 375, and 430 CSS pixels. No horizontal page overflow; wide content scrolls inside
  its own container.
- **Accessibility:** keyboard navigation, focus states, screen-reader labels, reduced motion.
- **Evidence:** a public number, quality label, or claim must be traceable to a versioned artifact or
  deterministic input checksum.

---

## 13. Execution checklist

1. Read this plan, `ENHANCEMENT_PLAN.md`, and the three ADRs under `docs/architecture`.
2. Run `git status -sb` and preserve unrelated changes.
3. Verify current code rather than trusting a status note — including this one.
4. Start with WP0; it is five minutes and prevents duplicate work.
5. Complete one package end to end — contracts, service, route, UI, tests, provenance — before
   starting the next.
6. Run the completion commands in Global Constraints before declaring a package done.
7. Update the `ENHANCEMENT_PLAN.md` ledger and this document's status when a package lands,
   including ROS artifact/profile coverage and methodology evidence versions.
