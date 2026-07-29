# Rest-of-Season Availability — Implementation Plan

- Status: WP1/WP4/WP4a/WP4b complete; WP5 (re-admission) open
- Last updated: 2026-07-29
- Companion to: `ENHANCEMENT_PLAN.md`, `docs/REMAINING_ENHANCEMENTS_PT1.md`, `docs/operations.md`

**Goal:** Get all three admitted scoring profiles to zero availability blockers, so rest-of-season
projections publish for standard, half-PPR, and full-PPR leagues this season — or establish, with
evidence, that the current ceiling is not reachable and say so plainly instead.

**Architecture:** One diagnostic gates everything. Only after it distinguishes _reducible model
error_ from _irreducible outcome dispersion_ does any model work begin, and the branch it selects
determines which of the later packages exist at all. Every change is validated by the same frozen
walk-forward process, with no gate, threshold, tolerance, or minimum altered in either direction.

**Tech Stack:** TypeScript, Drizzle/PostgreSQL, Vitest.

---

## Global Constraints

Every package's requirements implicitly include this section.

- **Do not relax a gate, threshold, tolerance, or minimum to make a profile pass.** A failing cell
  ships withheld, with its evidence. This applies even when a miss is hundredths of a point.
- **Leakage safety is absolute.** The replay must never receive undated final roster or injury
  status as a target-week feature. Every status feature is as-of the forecast cutoff and obeys the
  same walk-forward discipline as everything else. A model that sees a player's final week-12 status
  while forecasting week 12 will look excellent and be worthless.
- **Pre-commit the sample before running.** Declare players-per-position and accept the result,
  including cells that currently pass and then fail at a tighter estimate. Re-running for a
  friendlier draw is a forking path, not evidence.
- **Evidence snapshots are immutable** (section 2.3). Supersede stale entries with dated new ones;
  never rewrite them. Admission is append-only and selects the newest artifact per profile by
  `admittedAt`; older rows stay as history.
- **Database safety.** Never run a migration or write against a default or implicit URL. Use a
  disposable database with its URL passed explicitly, and never touch the Compose database except
  through the admission command with an explicit `--database-url`.
- **Validation runs are expensive and fragile.** ~3.4 h per profile at 5 players/position, ~5.5 h at 8. No checkpointing — an interrupted run restarts from zero. Detach with `setsid nohup`, and
  redirect through `npm run --silent` (or invoke `tsx` directly) so npm's banner does not corrupt the
  report. Verify a finished report begins with `{`.

**Completion commands** — before declaring any package complete:

```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
git diff --check
```

---

## 0. Where things actually stand

Three scoring profiles are admitted in production, superseded on 2026-07-28 by 8-player-per-position
artifacts:

| Profile  | Artifact checksum | Report state   | Blockers                       |
| -------- | ----------------- | -------------- | ------------------------------ |
| full-ppr | `739b8306e3f3`    | `insufficient` | QB nine-plus, WR five-to-eight |
| half-ppr | `f419d48b3145`    | `insufficient` | QB nine-plus                   |
| standard | `2ab659edb7b3`    | `insufficient` | QB nine-plus                   |

All graded 3,264 forecasts across 68 batches, 0 skipped, with 144 convergence diagnostics all
converged (72 diagnosed pairs × 2 strategies — `diagnosedPairs` is 72; do not quote it as the
diagnostic count).

**Every blocker is an availability cell.** No scoring or production cell has failed in any recent
run. The production model is not the problem; the games-played model is.

### The measured picture

`expectedGamesRowMae` by position and bucket, standard profile, against ceilings of 1.5
(one-to-four, five-to-eight) and 2.75 (nine-plus):

| Position | one-to-four | five-to-eight | nine-plus |
| -------- | ----------: | ------------: | --------: |
| QB       |       0.655 |         1.365 | **2.764** |
| RB       |       0.579 |         1.391 |     2.733 |
| WR       |       0.537 |         1.491 |     2.318 |
| TE       |       0.438 |         1.207 |     2.184 |
| K        |       0.239 |         0.934 |     2.223 |

Two facts constrain any explanation. Error grows monotonically with horizon for every position. And
at the larger sample nine-plus error rose for QB, RB, WR and K in all three profiles — under standard,
QB 2.673→2.764, RB 2.528→2.733, WR 2.147→2.318, K 2.029→2.223 — while **TE fell** under full-PPR and
half-PPR. So the 5-player sample was optimistic about long-horizon availability for most positions,
but the movement is not universal, and any explanation that requires it to be is wrong.

### A correction to an earlier diagnosis

`ENHANCEMENT_PLAN.md` prescribes replacing an "over-broad availability hazard" with a
"position/status/role model." **That description no longer matches the code.**
`historicalRosAvailabilityFor` (`apps/worker/src/first-party-ros-backtest.ts:907`) already keys on
`${position}:${streakBucket}`, branches recovery on availability state, and shrinks a personal
empirical rate toward a stratum asymptote. Role is conditioned separately through
`roleCalibration.byPosition`. Position, status, and role conditioning are largely **already built**.

Anyone starting from the ledger's wording will build something that exists. Start from the code.

### The open question this plan is organised around

Two narrower observations survive that correction, and both are unproven:

1. For any player with trailing history, the personal blend **overwrites** the position-specific
   absence rate: `absence = clamp(jointRecovery × (1 − blended) / max(blended, 0.05), 0.005, 0.5)`.
   `jointRecovery` is drawn from `recoveryByPositionStreak` but the reconstruction discards the
   separately fitted `newAbsenceByPositionStreak` value.
2. That reconstruction is a **steady-state identity** — it assumes the player sits at his long-run
   availability asymptote. Harmless over one to four weeks; its error compounds over nine to
   seventeen, which is exactly where every failure lives.

And three parameters — `reserveRecoveryProbability`, `limitedRoleMultiplier`,
`returnRoleMultiplier` — are taken from `calibration.global` with no position conditioning at all.

**None of this is established.** It is a reading of the code, not a measurement. WP1 exists to test
it, and to answer a prior question that determines whether any of it matters.

---

## WP1 RESULT — completed 2026-07-28: no headroom, branch is WP4

The diagnostic ran and **refuted every model-side hypothesis in this document.** Method: the audited
row set was rebuilt with the repo's own selection code and `expectedGames` replicated in closed form
(the availability chain is a two-state Markov process independent of production, so no simulation is
needed). Closed-form and reported MAE/bias agree to ≤0.004 across all 45 cells × 3 profiles.

**There is no headroom.** Nine-plus, standard, N=8: model 2.444 against trivial baselines of 2.892
(all scheduled), 2.498 (own trailing rate) and 3.549 (position base). A LOSO cross-fitted oracle — a
perfect nonparametric predictor over (position, streak, state) — reaches 2.372, a paired difference of
+0.072 with 95% CI [−0.018, +0.160], **not significant**. For QB, the one failing cell, the oracle is
_worse_ than the model (3.01). A LOSO conditional-**mean** oracle, which is the estimand
`expectedGames` actually reports, scores 2.625 — worse than the shipped model. For TE the trivial
baseline beats the model, and nothing else does.

**The MAE and bias ceilings are mutually unsatisfiable at long horizon.** Availability is strongly
left-skewed: median fraction 0.909 against mean 0.755, with 42% of rows playing every game. The only
thing that lowers nine-plus MAE is predicting the conditional median (2.370) — at bias +1.38, which
breaches `FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS = 1.0`. The two gates cannot both be satisfied.

**Bias is not the problem.** Nine-plus pooled bias is +0.008; per position QB +0.25, RB −0.52,
WR −0.21, TE −0.18, K +0.71 — all far inside 1.0. LOSO-debiasing by (position, streak, state) makes
MAE _worse_ (2.521): no stable bias exists to remove. The worst 10% of rows carry 31% of total error.

### Every hypothesis in §0 was wrong

- **(1) refuted twice.** `jointRecovery` reads `recoveryByPositionStreak["${position}:${bucket}"]`
  (`first-party-ros-backtest.ts:918`) and **is** position-conditioned, as is
  `asymptoteByPositionStreak`. Substituting the position recovery is bit-identical. Worse for the
  hypothesis: deleting the personal blend makes nine-plus **worse** (2.628 vs 2.444; QB 3.00 vs 2.76).
  The blend is the model's single largest source of skill, not a bug.
- **(2) refuted.** Predicted-minus-observed availability by lag runs −0.02…+0.01 for lags 1–9 and only
  reaches +0.05…+0.10 at lags 16–17 (n ≤ 320). Net ≈ −0.01 games on a typical window, ≤7% of error,
  and sign-offsetting.
- **(3) refuted by construction.** `limitedRoleMultiplier` and `returnRoleMultiplier` scale production
  only (`rest-of-season.ts:1370-1377`) and cannot move `expectedGames` at all.
- **(4) marginal.** Streak resolution is the only positive signal, worth ~0.07 games, not significant.

### Latent bug found in passing

`reserveRecoveryProbability` is inert: **0 of 2,720 audited rows** are in state `reserve`, because
nflverse `RES` normalizes to `inactive` rather than `ir`. The branch cannot execute. Worth fixing on
its own terms — a parameter that can never apply is a silent hole in the availability model — but it
is not the cause of any current failure.

### The gate is measuring sampling noise

QB nine-plus is 2.763 against 2.75, and bootstrap P(MAE > 2.75) = **0.54**. The identical cell scored
2.64–2.67 at N=5 and 2.76–2.81 at N=8 over the same seasons. A gate whose outcome is a coin flip on
sample draw is not measuring model quality.

**Branch selected: WP4 (threshold review). Do not build WP3.** The diagnostic supplies most of what
WP4 Step 2 asks for: the oracle floor sits at 2.37–2.63. A ceiling near 3.1 would preserve the same
margin over the oracle floor that 2.75 held over its own. That revision still needs the WP4 discipline
— derivation reconstructed, recorded, superseded rather than overwritten, and published.

### Still unknown

- Monte-Carlo noise in the shipped `expectedGames` (bounded by the ≤0.004 closed-form agreement, not
  directly measured).
- Whether a **new feature class** — snap trend, injury-designation history, depth-chart or benching
  signal — has headroom. The oracles bound only the _existing_ feature set, so this is the one
  remaining avenue by which a model fix could still pay off.

---

## WP1 — Diagnostic (gates everything else)

**Nothing downstream may begin until this completes.** Its purpose is to prevent building a model fix
that cannot work.

### The primary question

**Is 2.75 near the irreducible floor, or is there real headroom?** From the same held-out rows the
audit uses, compute `expectedGames` MAE for trivial baselines at each bucket:

- every remaining scheduled game is played;
- the player's own trailing availability rate × scheduled games;
- the position's base rate × scheduled games.

- If the model barely beats the best trivial baseline at nine-plus, the model adds little and the fix
  is modelling. **Proceed to WP3.**
- If the model is far better and every baseline also lands ~2.2–2.8, the ceiling sits near the noise
  floor, no model change will clear it, and the honest response is to revisit the threshold's
  derivation rather than the model. **Proceed to WP4.**

### The second question

Decompose nine-plus error into bias (mean signed error) and dispersion. Bias near zero with MAE 2.7
means a centred model facing irreducible variance in who gets injured — a fundamentally different
problem from a systematically optimistic one, with a different fix. `FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS`
is 1.0 and is not currently breached, which is itself evidence worth interpreting.

### The third question

Rank these by evidence, and **actively attempt to refute the first two**:

1. The personal blend discards the position-specific absence rate.
2. The steady-state identity degrades with horizon.
3. Three availability parameters are global, not position-conditioned.
4. Streak-bucket resolution is too coarse.
5. None of the above — the error is dominated by something else, or is irreducible.

A diagnostic that confirms a stated hypothesis is worth nothing. **(5) is a legitimate and valuable
answer.**

- [ ] **Step 1: Baseline comparison.** Compute the three trivial baselines per bucket from the stored
      reports; produce a model-vs-baseline table.
- [ ] **Step 2: Bias/dispersion decomposition** by position and bucket.
- [ ] **Step 3: Rank the five candidates** against evidence, stating explicitly which were refuted.
- [ ] **Step 4: Record the finding** in this document as a dated section, and select the branch:
      WP2 → WP3 (model fix) or WP4 (threshold review).

**Cost:** cheap. Arithmetic over six ~85 KB reports plus read-only SQL. No validation runs, no
simulation, minutes not hours.

**Exit criteria:** the branch is chosen on measured evidence, and what was measured is distinguished
from what was inferred.

---

## WP2 — Validator sharding (enabler; only if WP1 selects the model branch)

Each model iteration costs three profiles × 5.5 h. Two or three iterations is a working week of
wall-clock. This package pays for itself on the second iteration and is wasted effort otherwise —
hence its position behind WP1.

**It is provably safe to parallelise.** The RNG seed is derived entirely from each forecast's own
identity (`packages/projections/src/rest-of-season.ts:1354`): seed version, caller seed, input
checksum, player id, strategy, season, as-of week, as-of timestamp, window bounds. There is no shared
sequential stream, so execution order cannot alter a single number. The codebase states the invariant
directly (`:11-15`): the seed version changes "if and only if non-K draw consumption changes."

Walk-forward means each batch depends only on prior _data_, never on prior batch _output_, so batches
are independent. The host has 6 cores; a run currently uses ~1.

- [ ] **Step 1: Shard by cutoff batch** across N processes, each emitting a partial report.
- [ ] **Step 2: Merge partial reports** without perturbing evidence identity or artifact checksum.
      This is the actual work; the sharding itself is easy.
- [ ] **Step 3: Prove equivalence.** Re-run one existing profile sharded and assert the artifact
      checksum is **byte-identical** to the serial run. **Do not trust any sharded result until this
      passes.**
- [ ] **Step 4: Record the measured speedup** in `docs/operations.md`.

**Exit criteria:** a sharded run reproduces a known artifact checksum exactly, and per-profile
wall-clock drops materially from 5.5 h.

---

## WP3 — Availability model fix (only if WP1 finds reducible error)

The specific change depends on WP1's ranking; do not pre-commit to one. Candidates, cheapest first:

- [ ] **Task 3.1 — Stop discarding the position-specific absence rate.** If cause (1) ranks highest,
      blend the personal rate _toward_ `newAbsenceByPositionStreak` rather than reconstructing
      absence from a position-agnostic recovery term.
- [ ] **Task 3.2 — Replace the steady-state identity with a horizon-aware form** if cause (2) ranks
      highest. The assumption that a player sits at his long-run asymptote is what compounds; a
      transient-aware formulation should not.
- [ ] **Task 3.3 — Position-condition the three global parameters** if cause (3) carries weight.
- [ ] **Task 3.4 — Refine streak buckets** if cause (4) carries weight. Lowest expected value;
      sequence last.

Each task: change, then one pre-committed validation pass at the declared sample size, then measure.
**One change per validation cycle** — two simultaneous changes make the result uninterpretable.

**Constraints specific to this package:**

- Any new feature must be as-of the cutoff. Status and injury data carry the outcome inside them.
- The seed version changes if and only if non-K draw consumption changes. If a change alters draw
  consumption, that is a new model version and a global reseed, and the isolation proof that
  non-affected positions are numerically unchanged must be redone.
- Do not tune against the held-out corpus. It has already been replayed several times and is
  development evidence, not a clean holdout.

**Exit criteria:** QB nine-plus below 2.75 and WR five-to-eight below 1.5 across all three profiles at
the pre-committed sample, with no gate altered and no other cell regressed.

---

## WP4 RESULT — completed 2026-07-28: 2.75 stands, no change made

The review ran and concluded **no revision is warranted**. No file was changed.

**The original derivation is not recorded anywhere.** No script, report, or written computation
exists. Git holds one squashed commit that added the rationale comment fully formed, and the replay
it was ratified against was never tracked. The only other prose is `docs/PROJECTIONS.md:83-88`, which
claims "≈0.165 × scheduled weeks at every horizon" — inconsistent with the corpus, since nine-plus
mean scheduled weeks is 12.12 and 0.165 × 12.12 = 2.00, not 2.26. Reconstructions of the described
oracle land anywhere from 2.05 to 2.94 depending on stratum and mean-vs-median; 2.26 is not
identified by any of them. **The 0.49 margin has no recorded basis.**

**Recomputed floor.** The 2,720-row audited set was rebuilt per profile with the repo's own
selection and calibration code, substituting the closed form for `expectedGames` (verified: all 45
cells × 3 profiles agree to ≤0.0033 MAE). Nine-plus pooled floor **2.53–2.59** (central 2.57);
five-to-eight 1.33–1.37; one-to-four 0.54–0.57. Dispersion per scheduled week is ≈0.21 and nearly
constant across horizons — so the recorded _structure_ is real even though the constant is not 0.165.

**Why 2.75 survives.** The only ratified margin is the one 1.5 embodies at a horizon its own comment
calls "attainable and attained." Transposing that precedent onto nine-plus gives 2.60–2.67 read as an
absolute margin, or 2.76–2.91 read proportionally. **2.75 sits between the two readings**, and is the
only candidate consistent with both; neither neighbouring value is. Against the floor directly,
2.75/2.57 = 1.070 versus 1.5/1.35 = 1.111 at five-to-eight — the same family.

**≈3.1 was rejected**, and the reasoning is worth keeping: it computes 2.63 + 0.49, which inherits
the undocumented margin verbatim — laundering an unrecorded number into a freshly "derived" one — and
adds a margin calibrated against an _in-sample_ floor to a _LOSO_ floor, double-counting the
cross-fitting penalty. Correcting either defect drops it below 2.9. It also implies a worst-position
standard that 1.5 demonstrably does not use: WR five-to-eight's own floor is 1.52–1.66, above its
ceiling, and that cell stays withheld.

### The actual defect is the decision rule, not the constant

Block-bootstrap P(MAE > 2.75) for QB nine-plus is 0.53–0.67 with cell SE ≈0.15. The gate is a
point-estimate comparison against a statistic whose noise exceeds the distance being measured — it
fires on sample draw, which is exactly what the N=5 → N=8 flip demonstrated.

**This is a solved problem in this codebase.** Coverage gate v3 fixed the identical pathology by
replacing a point-estimate comparison with a one-sided evidence test at alpha 0.1
(`firstPartyRosCoverageEvidenceOfUndercoverage`). That change did not relax the standard; it stopped
the gate firing on noise. The availability MAE gate should follow the same precedent.

**This is the recommended next work, and it is not a threshold relaxation.** It leaves 2.75 in place
and changes only how evidence against it is weighed. _(Done 2026-07-28 — see WP4a RESULT below.)_

### Separate finding worth its own attention

Model-implied dispersion is 1.86 against realized 2.44 — the availability chain is **under-dispersed
by roughly 30% at long horizon**. That is a real modelling observation, independent of any gate, and
it is not addressed by anything above.

---

## WP4a RESULT — completed 2026-07-28: decision rule replaced, 2.75 untouched

WP4's recommendation was implemented. **No ceiling moved.** `FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE`
(1.5), `FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE` (2.75) and
`FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS` (1.0) are byte-identical to what gate v2 ratified on
2026-07-21. What changed is only the comparison: `historicalRosCalibrationBlockers` now fails an
availability cell on a one-sided evidence test rather than on a point estimate, following coverage
gate v3 exactly — same alpha (0.10), same exact-binomial machinery, same blocker name.

### The test

`firstPartyRosAvailabilityEvidenceOfExcessMae(samples, mae, ceiling, maximumRowError, alpha)`,
beside `FIRST_PARTY_ROS_AVAILABILITY_EVIDENCE_ALPHA` in `packages/projections/src/rest-of-season.ts`.
H0 is "the cell's true MAE is at most the ceiling", and the cell blocks only when the observed MAE
is too extreme for that null.

The report records a cell's MAE and its row count and **nothing about the spread of its per-row
absolute errors**, so the null dispersion cannot be estimated from the evidence — it has to be
bounded, and the bound has to be structural or the gate is assuming a distribution nobody measured.
Each row's absolute error lies in `[0, maximum row error]`, where the maximum is 4, 8 and 17 games
by bucket (prediction and outcome both lie in `[0, scheduled games]`, scheduled games cannot exceed
the window length, and no NFL team plays more than 17 games in an 18-week season). Among all laws on
that support with mean equal to the ceiling, the two-point law on the endpoints carries the most
variance (Bhatia–Davis) — the standard least-favourable case for an upper-tail test of a bounded
mean — and under it `samples × MAE / maximumRowError` is exactly `Binomial(samples, ceiling /
maximumRowError)`. The tail is therefore computed exactly, not approximated.

That bound is loose, and the slack buys two things: no distributional assumption, and headroom
against the within-block correlation a row-independent test would otherwise ignore (it admits about
six times the variance WP4's block bootstrap measured — any design effect a slate of eight
correlated players could plausibly carry). What it costs is power, and the cost is stated rather
than hidden: at 288 rows a nine-plus cell fails from about **3.25** games, at 128 rows a
five-to-eight cell from about **1.88**, at 128 rows a one-to-four cell from about **1.72**. A cell
genuinely and substantially over its ceiling still blocks; a cell hundredths over it no longer does.

**The bias gate keeps its point comparison.** WP1 established that bias is the check that actually
detects hazard mismatch, its estimator is a signed mean rather than a boundary-hugging absolute one,
and every cell passes it with room to spare. Nothing about it is measuring noise.

### Measured effect on the stored corpus

Re-gated with `npm run ros:regate -w @fantasy/worker` — gate-only re-evaluation of stored evidence.
**No validation run was performed.**

| Report                                  | Before                                   | After              |
| --------------------------------------- | ---------------------------------------- | ------------------ |
| `ros-validation-v8-standard-n8`         | QB nine-plus MAE                         | none               |
| `ros-validation-v8-half-ppr-n8`         | QB nine-plus MAE                         | none               |
| `ros-validation-v8-full-ppr-n8`         | QB nine-plus MAE, WR five-to-eight MAE   | none               |
| `ros-validation-v8-standard-2026-07-27` | WR five-to-eight MAE, K one-to-four cov. | K one-to-four cov. |
| `ros-validation-v8-half-ppr-2026-07-27` | K one-to-four coverage                   | K one-to-four cov. |
| `ros-validation-v8-2026-07-23`          | none                                     | none               |

No blocker was added anywhere; no coverage, convergence, sample-size or bias blocker moved. All six
availability-MAE blockers on the corpus were cells sitting 0.014–0.059 games over their ceiling —
every one inside the noise the gate was firing on.

### Versioning

`FIRST_PARTY_ROS_POLICY_VERSION` is **not** bumped, and `FIRST_PARTY_ROS_SEED_VERSION` is untouched
(no draw consumption changed). The precedent is coverage gate v3, which made the identical kind of
change and left the policy version alone, recording itself as Amendment 3 of
`docs/ros-v6-2026-untouched-protocol.md` instead. Three reasons hold here too: the constant names
the champion-selection policy (season walk-forward, block WIS, CQR), none of which moved; it is a
frozen row of that pre-registered protocol, so changing it would void the 2026 untouched proof; and
`validateFirstPartyRosAdmission` tests it for equality, so a bump would reject every currently
admitted artifact and every stored report. Artifact checksums do move, because `report.blockers`
feeds them — which is content addressing working as intended, not a compatibility break.

### Still to be ratified or done — this change is not yet in production

- **The pre-registered protocol needs an Amendment 4.** `docs/ros-v6-2026-untouched-protocol.md`
  freezes the release criterion "expected-games MAE ≤ 1.5 / ≤ 2.75" as a point comparison. Its
  amendment policy requires Mack's written ratification; that has not been sought here, and until it
  is, the 2026 untouched proof still names the superseded rule. _(Done 2026-07-29 — Amendment 4
  ratified on operator direction; see WP4b RESULT below.)_
- **The live release gate still uses the point comparison.** `evaluateFirstPartyRosReleaseGate`
  (`packages/projections/src/rest-of-season.ts`) raises `availability-error-above-threshold` off the
  same held-out MAE, and `first-party-ros-publication.ts` applies it after the admitted cell
  blockers. So a cell that stops being named by the report would **still be withheld at publish
  time**. Until that gate is changed in the same way, this change moves the report verdict and
  nothing a league can see. It was left alone deliberately — it is a production publication
  decision, not a report verdict. _(Done 2026-07-29 — see WP4b RESULT below.)_
- **`docs/PROJECTIONS.md` "Ratified threshold changes" and the withheld-cell copy in
  `apps/web/src/app/methodology/evidence.ts`** both still describe the superseded rule. _(Done
  2026-07-29: the copy lives in `docs/operations.md` — `docs/PROJECTIONS.md` does not exist in the
  tree and this entry's reference to it was stale — and both `operations.md` and the methodology
  copy now record the aligned rule; see WP4b RESULT below.)_
- **Nothing has been admitted.** The re-gated reports live outside the repository; the provisioned
  artifacts keep the blockers they were admitted with. _(Still true on 2026-07-29 — admission is
  WP5 territory and is deliberately not exercised by WP4b.)_

---

## WP4b RESULT — completed 2026-07-29: live release gate aligned, ratified as Amendment 4

WP4a's "still to be ratified or done" items are done, on the operator's direction of 2026-07-29.
**No ceiling moved, and no version was bumped** — `FIRST_PARTY_ROS_POLICY_VERSION` and
`FIRST_PARTY_ROS_SEED_VERSION` are untouched, on the same precedent WP4a followed.

- **Amendment 4 is ratified and recorded** in `docs/ros-v6-2026-untouched-protocol.md`
  (pre-kickoff, written justification appended, availability gate v3 named in the frozen criteria
  the way Amendment 3 named coverage gate v3).
- **`evaluateFirstPartyRosReleaseGate` applies the identical evidence test** the report gate has
  applied since 2026-07-28: point comparison retained as a structural guard, cell withheld only on
  `firstPartyRosAvailabilityEvidenceOfExcessMae(choice.samples, mae, ceiling, rowErrorBound[bucket],
α = 0.10)`. The bias gate keeps its point comparison. A new `availabilityEvidenceAlpha` option and
  the bucket row-error bound join the gate's evidence-checksum thresholds, so live evidence
  checksums move; admitted artifact checksums do not.
- **The live gate's evidence identity is position-scoped** — both comparisons (policy identity →
  `evidence-identity-mismatch`, and the interval-calibration artifact identity →
  `interval-calibration-unavailable`; scoping only the first would have been defeated by the
  second). Semantics: version fields compare exactly; byte-equal whole keys match on a fast path;
  otherwise both keys are recovered via `projectionScoringRulesFromProfileKey` and compared as
  `projectionScoringProfileKeyForPosition` at the cell's position, failing closed on unparseable
  keys and on `"[]"`. This is `docs/ROS_GATE_AND_DST_PLAN.md` WP0, executed
  here because the live gate is this plan's territory. The publication test that pinned the
  whole-key defect now pins the fix: a partially matched league publishes its matched positions.
- **What a league sees is still governed by admitted evidence.** The admitted-cell-blocker ratchet
  is untouched: cells named by the currently admitted artifacts (QB nine-plus ×3, WR five-to-eight
  full-PPR on the legacy trio) stay withheld until a later replay stops naming them and is
  admitted. Clearing them honestly is WP5 (pre-committed sample, frozen process, admission) and was
  deliberately not smuggled into this change.

### What would tighten this test honestly

The conservatism is a direct consequence of the report not recording the dispersion of its own
per-row absolute errors. Recording a block-bootstrap standard error for `expectedGamesRowMae` per
cell — evidence the validation run already holds and discards — would let the same one-sided test
run against a measured null instead of a least-favourable one, moving the nine-plus bar from about
3.25 games to about 2.94. That is a strictly stronger gate, and it needs a fresh run to produce the
new field, so it is a candidate for the next validation cycle rather than a re-gate.

---

## WP4 — Threshold review (only if WP1 finds the ceiling near the noise floor)

If no model change can clear 2.75, the honest response is to examine how 2.75 was derived — **not to
raise it because cells are failing**. Those are different acts and only one is legitimate.

The existing derivation is recorded at `packages/projections/src/rest-of-season.ts:42-46`: 1.5 was
"retained for the one-to-four and five-to-eight windows, where it is attainable and attained," and
nine-plus received its own ceiling because 9–17 weeks of injury and roster outcomes "carry that much
irreducible dispersion." Both were derived from what the data supports. Any revision must be derived
the same way and must be defensible without reference to which cells currently fail.

- [ ] **Step 1: Reconstruct the derivation** of 2.75 from the evidence that produced it.
- [ ] **Step 2: Recompute the dispersion floor** from the current corpus, blind to current failures.
- [ ] **Step 3: If the floor genuinely exceeds 2.75**, revise with the derivation recorded, the old
      value superseded rather than overwritten, and the reasoning published on `/methodology`.
- [ ] **Step 4: If it does not**, leave the threshold alone and accept the cells as withheld.

**Exit criteria:** either a threshold with a written derivation independent of current results, or a
recorded decision to accept the withheld cells.

---

## WP5 — Re-admission and publication

- [ ] **Task 5.1** — Pre-commit the sample size, run all three profiles through the frozen process,
      and accept the outcome.
- [ ] **Task 5.2** — Validate each report through `validateFirstPartyRosAdmission` before admitting.
- [ ] **Task 5.3** — Admit each profile with an explicit `--database-url` and `--confirm`. Admission
      is idempotent: a repeat returns `already-admitted` rather than duplicating, so an interrupted
      run is safe to retry.
- [ ] **Task 5.4** — Verify supersession: the newest artifact per profile is selected by
      `admittedAt`, and older rows remain as history.
- [ ] **Task 5.5** — Update `/methodology` figures and the landing stat strip **from the artifacts**,
      never transcribed. The strip publishes per-validation-run figures only — never lifetime totals,
      because replays over the same held-out seasons double-count evidence.
- [ ] **Task 5.6** — Supersede the stale entries in `ENHANCEMENT_PLAN.md` and `docs/operations.md`
      with dated new ones.

**Exit criteria:** admitted artifacts, published figures, and the database all agree, and every
published number is traceable to an artifact.

---

## What this plan does not claim

- **It does not promise clean out-of-sample validation this season.** The untouched release proof is
  the frozen protocol in `docs/ros-v6-2026-untouched-protocol.md`, runnable only after the 2026
  season resolves. Everything here runs on development evidence, and the public page must keep
  saying so.
- **It does not assume a model fix is possible.** WP1 may find the ceiling near the noise floor. That
  is a legitimate outcome and WP4 exists for it.
- **An admitted cell blocker genuinely withholds that cell — correcting an earlier claim in this
  plan.** `first-party-ros-admission.ts:152-153` says such cells are "re-evaluated by the release
  gate," which reads as though a marginal cell still reaches publication on live evidence. It does
  not. `first-party-ros-publication.ts:234-249` computes the live gate, then overrides it:
  `state: blocked ? "withhold" : gate.state`, raising `ros_admitted_cell_blocker_withheld`. The live
  gate decision is retained for observability only. A blocked cell clears only when a **later replay
  stops naming it**.

  So the currently withheld cells are real, not cosmetic: QB nine-plus in all three profiles, plus WR
  five-to-eight in full-PPR. Standard and half-PPR publish 17 of 18 cells; full-PPR publishes 16.
  This is precisely why WP1 is load-bearing — it decides whether those cells can be cleared honestly
  or whether the threshold's derivation is what needs revisiting.

## Execution checklist

1. Read this plan, then `ENHANCEMENT_PLAN.md` §2.2 and the three ADRs under `docs/architecture`.
2. **Read the code before the ledger.** The ledger's availability wording is stale; §0 above records
   how.
3. Run `git status -sb` and preserve unrelated changes.
4. Start with WP1. Do not begin WP2 or WP3 before it selects a branch.
5. One change per validation cycle.
6. Run the completion commands before declaring any package done.
7. Update this document's status and record each measured result with its date.
8. Deploy, commit, or push only when asked.
