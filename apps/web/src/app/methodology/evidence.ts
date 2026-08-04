/**
 * Versioned evidence manifest for the public `/methodology` page.
 *
 * Every number rendered on that page is read from this module, and every value here was
 * transcribed from a real validation artifact or from the running engine's own constants — never
 * from a planning document. The `source` field on each record names the exact file (and, where the
 * value is computed rather than stored, the function that produces it) so a reader can re-derive
 * it. `evidence.test.ts` pins these values so page copy cannot drift away from its evidence.
 *
 * Provenance of the rest-of-season block: one validation report per scoring profile.
 *
 * - Full PPR: `reports/ros-validation-v8-full-ppr-n8-2026-07-28.json`
 * - Half PPR: `reports/ros-validation-v8-half-ppr-n8-2026-07-28.json`
 * - Standard: `reports/ros-validation-v8-standard-n8-2026-07-28.json`
 * - Standard + 2-pt: `reports/ros-validation-v9-espn-standard-2pt-n8-2026-08-03.json`
 * - Standard + 2-pt, no XP-missed:
 *   `reports/ros-validation-v9-espn-standard-2pt-nxm-n8-2026-08-03.json`
 *
 * Those files are local operator artifacts — `reports/` is listed in `.gitignore`, so they are
 * deliberately not distributed with the repository and the page must not link to them as if they
 * were public. The file names carry the operator's local date; each report's own `.generatedAt` is
 * UTC and is what every `evaluatedAt` below is read from.
 *
 * The first three reports re-ran the same replay at eight sampled players per position and cutoff
 * instead of five, with every other default unchanged and no gate, threshold, tolerance, or
 * minimum altered in either direction. They superseded the five-player reports as validation
 * evidence:
 * `apps/worker/src/first-party-ros-projections.ts` selects per profile with
 * `orderBy(desc(admittedAt))`, and the five-player rows are retained in the database as immutable
 * history. Nothing read from those older reports may be republished here as a current figure — see
 * `evidence.test.ts`, which pins every superseded value as stale.
 *
 * Every admission decision and artifact checksum below was reproduced by running the production
 * `validateFirstPartyRosAdmission` from `apps/worker/src/first-party-ros-admission.ts` against the
 * corresponding report, once per profile via `firstPartyRosAdmissionConstants(profile)`; that
 * function is pure, so the result is reproducible by any operator holding the reports. The
 * `admittedAt` dates are the `admitted_at` column of `first_party_ros_champion_artifacts` in the
 * production database, matched to these rows by `artifact_checksum`. Admission is append-only.
 * Gate-only re-evaluations of the first three reports therefore coexist with their original rows;
 * production selects the newest compatible artifact, while this manifest preserves the original
 * replay verdict that produced each measurement below.
 *
 * The two `espn-standard-*` profiles are league-shaped catalog profiles. Their 2026-08-03 v9
 * replays contain the complete ESPN D/ST rule vocabulary and native `--full` source lineage. They
 * were replayed at eight players per position from the start, so there is no narrower-sample
 * predecessor for those two profiles.
 */

export const METHODOLOGY_EVIDENCE_MANIFEST_VERSION = "methodology-evidence-v5" as const;

export interface EvidenceFigure {
  /** Human label rendered in the page's evidence tables. */
  readonly label: string;
  /** Rendered value, already formatted for display. */
  readonly value: string;
  /** Exact artifact path/JSON pointer, or the code constant, the value was read from. */
  readonly source: string;
}

export interface ReleaseGateRow {
  readonly gate: string;
  readonly requirement: string;
  readonly outcome: string;
  readonly state: "pass" | "fail" | "withheld";
}

/** One independently validated and independently admitted rest-of-season scoring profile. */
export interface RosProfileEvidence {
  /** `rosScoringProfile(key).key` */
  readonly key: string;
  /** `rosScoringProfile(key).label` — the plain-language name. */
  readonly label: string;
  /** The label prose uses when several profiles are listed in one sentence. */
  readonly shortLabel: string;
  /** `.report.forecasts`. */
  readonly forecasts: number;
  /** Whether this profile also has a five-player replay to compare against. */
  readonly narrowerSampleReplayed: boolean;
  /** The report's own `.generatedAt`, UTC date only. */
  readonly evaluatedAt: string;
  /** The report's own `.report.state`. Not an admission decision. */
  readonly reportState: string;
  /** The report's own `.report.blockers`, verbatim. Empty means the run recorded none. */
  readonly reportedBlockers: readonly string[];
  /** Which position/horizon cells those blockers withhold, in plain language. */
  readonly withheldCells: string;
  /** `validateFirstPartyRosAdmission(...).state` reproduced against the report. */
  readonly admissionState: string;
  /** `admitted_at` of the matching `first_party_ros_champion_artifacts` row, UTC date only. */
  readonly admittedAt: string;
  /** `validateFirstPartyRosAdmission(...).artifactChecksum`, equal to the admitted row's. */
  readonly artifactChecksum: string;
  /** `rosScoringProfile(key).digest` — sha256 of the canonical scoring key. */
  readonly scoringProfileDigest: string;
}

/* ------------------------------------------------------------------ *
 * Rest-of-season model
 * ------------------------------------------------------------------ */

/** Identity of the replay the rest-of-season claims are drawn from. */
export const rosArtifact = {
  /** `.generatedAt` */
  evaluatedAt: "2026-07-28",
  /** `.champion.modelVersion` */
  modelVersion: "laces-ros-distribution-v7",
  /** `.champion.policyVersion` */
  policyVersion: "season-walk-forward-block-wis-cqr-v4",
  /** `FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION` */
  calibrationVersion: "season-blocked-split-conformal-cqr-v1",
  /** `.identityAudit.intervalMethodVersion` */
  intervalMethodVersion: "simulation-p15-p50-p85-cqr-v1",
  /** `.report.availabilityCalibrationVersion` */
  availabilityCalibrationVersion: "historical-ros-availability-curve-matched-v3",
  /** `.report.roleCalibrationVersion` */
  roleCalibrationVersion: "historical-ros-role-center-two-moment-v4",
  /** `.report.kickerCalibrationVersion` */
  kickerCalibrationVersion: "historical-ros-kicker-count-process-v1",
  /** `firstPartyRosChampionArtifactChecksum(payload)` over the admissible payload. */
  artifactChecksum: "739b8306e3f3212542d2f778575bfe741b79e8660bc27357d86064f1554996a1",
  /** sha256 of `projectionScoringProfileKey(HISTORICAL_ROS_SCORING_PROFILE)`. */
  scoringProfileDigest: "dd74455ddb551d53f68ba9420f4446aebf63e3e8ea34efd24119cc780c47a484",
  /** `.champion.evidenceThroughSeason` */
  evidenceThroughSeason: 2025,
  /** `.report.state` */
  reportState: "insufficient",
  /** `validateFirstPartyRosAdmission(...).state` */
  admissionState: "admissible",
} as const;

/**
 * Plain-language names for the three remaining-weeks buckets the engine strata are keyed by
 * (`one-to-four`, `five-to-eight`, `nine-plus`). They live here rather than in page copy for the
 * same reason every other figure does: the page must not type a number into JSX, and a horizon
 * printed loosely is what would let a nine-plus result be read against a short-window ceiling.
 */
export const rosHorizonLabels = {
  oneToFour: "1–4 weeks",
  fiveToEight: "5–8 weeks",
  ninePlus: "9+ weeks",
} as const;

/**
 * The expected-games ceilings the availability gate holds cells to, read from
 * `packages/projections/src/rest-of-season.ts`. The nine-plus window is held to a wider ceiling
 * than shorter windows because an in-sample oracle over the same seasons still shows roughly 2.26
 * games of deviation there; the constant's own comment records that derivation. A nine-plus cell
 * must therefore never be compared against the short-window ceiling.
 */
export const rosAvailabilityCeilings = {
  /** `FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE` — one-to-four and five-to-eight windows. */
  shortHorizonMae: 1.5,
  /** `FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE` — nine-plus windows only. */
  ninePlusMae: 2.75,
  /** `FIRST_PARTY_ROS_MAX_AVAILABILITY_BIAS` — every window. */
  signedBias: 1,
} as const;

/**
 * How the availability gate decides a cell, read from `packages/projections/src/rest-of-season.ts`
 * and `apps/worker/src/first-party-ros-backtest.ts`.
 *
 * Availability MAE gate v3 (2026-07-28) left every ceiling above byte-identical and replaced the
 * decision rule. `historicalRosCalibrationBlockers` now raises `*_availability_mae_above_maximum`
 * only when the record is one-sided statistical evidence that the cell's *true* expected-games MAE
 * exceeds its ceiling — `firstPartyRosAvailabilityEvidenceOfExcessMae`, the same exact-binomial
 * machinery and the same alpha the interval-coverage gate has always used. The point comparison
 * survives only as a structural guard, so a cell inside its ceiling can never block. The
 * signed-bias ceiling deliberately keeps its point comparison: it is a signed mean rather than a
 * boundary-hugging absolute one, and nothing about it was measuring noise.
 *
 * Two consequences this page must state rather than smooth over:
 *
 * - The first three reports below were graded before the revision, so their recorded blocker lists
 *   are the point comparison's. A gate-only re-evaluation of that stored corpus
 *   (`npm run ros:regate -w @fantasy/worker`) cleared every availability blocker and was admitted as
 *   a new append-only artifact for each profile. The original rows remain as immutable history.
 * - On 2026-07-29 `evaluateFirstPartyRosReleaseGate` — the live publication gate — adopted the
 *   same one-sided evidence test at the same ceilings and the same alpha, and its
 *   evidence-identity comparison became position-scoped (`evidenceIdentitiesMatchForPosition`).
 *   What has not moved: `first-party-ros-publication.ts` still applies the admitted report's own
 *   blockers on top of the gate, so a cell named by admitted evidence stays withheld until a later
 *   replay stops naming it (the `ros_admitted_cell_blocker_withheld` ratchet is unchanged).
 *
 * No effective bar is published from this record. The alpha and the least-favourable bound that
 * set it are engine constants that can move without a new replay, and a number printed on the page
 * outlives the run that justified it.
 */
export const rosAvailabilityGate = {
  revisedAt: "2026-07-28",
  decisionRule: "one-sided evidence test against the same ceilings",
  ceilingsUnchanged: true,
  biasKeepsPointComparison: true,
  admittedEvidenceGradedUnderPointComparison: true,
  publicationGateAlignedAt: "2026-07-29",
  reportSource: "apps/worker/src/first-party-ros-backtest.ts",
  publicationSource: "apps/worker/src/first-party-ros-publication.ts",
} as const;

/** Held-out seasons, read from `.coverage.fullyHeldOutSeasons` (identical to `.report.seasons`). */
export const rosHeldOutSeasons = [2022, 2023, 2024, 2025] as const;

/** Input seasons supplying model history, read from the seven `.sources[].season` entries. */
export const rosSourceSeasons = { first: 2019, last: 2025, count: 7 } as const;

/**
 * Path counts, read from `packages/projections/src/rest-of-season.ts`. The release run is an exact
 * seeded prefix of the reference run, which is what makes the comparison a convergence check.
 */
export const rosScenarioPaths = {
  /** `FIRST_PARTY_ROS_DEFAULT_SCENARIOS` */
  release: 12_288,
  /** `FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS` */
  reference: 16_384,
} as const;

/**
 * Nominal width of the published interval. The interval method is
 * `simulation-p15-p50-p85-cqr-v1`, so the band runs from the 15th to the 85th percentile and its
 * nominal coverage is the difference between them. Both models publish this same band.
 */
export const nominalIntervalPercent = 85 - 15;

/** Convergence diagnostics recorded in `.report.convergenceAudit`, all with state `converged`. */
export const rosConvergence = { converged: 144, total: 144 } as const;

/** Graded forecasts, read from `.report.forecasts` (corroborated by `.identityAudit.inputChecksums`). */
export const rosForecastCount = 3264;

/** Sampled players per position and cutoff, read from `.report.playersPerPosition`. */
export const rosPlayersPerPosition = 8;

export const rosScopeFigures: readonly EvidenceFigure[] = [
  {
    label: "Fully held-out NFL seasons",
    value: "4 (2022, 2023, 2024, 2025)",
    source: "ros-validation-v8/v9-n8 .coverage.fullyHeldOutSeasons",
  },
  {
    label: "Forecasts graded against realized outcomes",
    value: "3,264 per profile",
    source: "ros-validation-v8/v9-n8 .report.forecasts",
  },
  {
    label: "Season/cutoff batches",
    value: "68 of 68 complete",
    source: "ros-validation-v8/v9-n8 .coverage.completeAsOfBatches / .totalAsOfBatches",
  },
  {
    label: "Forecasts skipped or dropped",
    value: "0",
    source: "ros-validation-v8/v9-n8 .report.skippedForecasts",
  },
  {
    label: "Position/horizon evidence cells",
    value: "18 of 18 complete",
    source: "ros-validation-v8/v9-n8 .report.cells",
  },
  {
    label: "Players sampled per position, per cutoff",
    value: "8",
    source: "ros-validation-v8/v9-n8 .report.playersPerPosition",
  },
  {
    label: "Simulation paths per release projection",
    value: "12,288",
    source: "FIRST_PARTY_ROS_DEFAULT_SCENARIOS (packages/projections/src/rest-of-season.ts)",
  },
  {
    label: "Simulation paths in the convergence reference run",
    value: "16,384",
    source:
      "FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS (packages/projections/src/rest-of-season.ts)",
  },
  {
    label: "Convergence diagnostics that converged",
    value: "144 of 144",
    source: "ros-validation-v8/v9-n8 .report.convergenceAudit",
  },
];

/**
 * Release gates, evaluated once across every replay because all profiles were graded at identical
 * scope. The publication row describes the live per-league, per-position gate in
 * `apps/worker/src/first-party-ros-publication.ts` — it was a standing "not performed / shadow only"
 * row until the rail began releasing, and is kept current rather than left as the historical
 * shape. Where a gate's outcome differs by profile, the outcome column names the profile.
 *
 * The availability row states each `.availabilityAudit` entry against the ceiling for its own
 * horizon, which is the comparison these reports' own blockers were raised on; `rosAvailabilityGate`
 * records the evidence test that has since replaced that decision rule at the same ceilings. The
 * interval row was re-derived by re-running `firstPartyRosCoverageEvidenceOfUndercoverage` over
 * every `.champion.choices[].walkForwardCalibration`. Both reproduce the reports exactly.
 */
export const rosGateRows: readonly ReleaseGateRow[] = [
  {
    gate: "Evidence volume",
    requirement: "At least 3 held-out seasons, 30 batches, and 300 graded outcomes.",
    outcome: "4 seasons and 68 batches in every replay, on 3,264 graded outcomes per profile.",
    state: "pass",
  },
  {
    gate: "Monte Carlo convergence",
    requirement:
      "Every position/horizon stratum must agree between the 12,288-path release run and the 16,384-path reference run.",
    outcome: "144 of 144 diagnostics converged in every replay.",
    state: "pass",
  },
  {
    gate: "Availability accuracy",
    requirement:
      "Expected-games error must show no statistical evidence of exceeding 1.5 games for 1-8 week windows or 2.75 for 9+ week windows, with signed bias at most 1.0 game.",
    outcome:
      "Not cleared by the three legacy profiles graded under the superseded point comparison: quarterback at 9+ weeks is over 2.75 in all three, worst 2.8091 (Full PPR), and wide receiver at 5-8 weeks is over 1.5 under Full PPR, at 1.5399. The two v9 catalog replays carry no availability blocker. Worst signed bias 0.7105 games (kicker, 9+, Standard), inside its ceiling everywhere.",
    state: "fail",
  },
  {
    gate: "Interval calibration",
    requirement:
      "No cell may show statistical evidence of undercoverage against a 60% floor for the nominal 70% interval.",
    outcome:
      "Team defense at 5–8 weeks failed in both v9 catalog replays: 0 of 4 walk-forward blocks covered against the nominal 70% interval. Every other catalog-profile cell passed.",
    state: "fail",
  },
  {
    gate: "Release blockers",
    requirement: "The report must carry no global or per-cell blockers.",
    outcome:
      "6 blockers across the five current reports: two under Full PPR and one under each remaining profile. Every blocker is cell-scoped; none is global.",
    state: "fail",
  },
  {
    gate: "Publication",
    requirement:
      "A league may receive a position's forecasts only when an admitted artifact validates against the running constants, its scoring identity matches that league for that position, the remaining-season window is complete, and the live release gate returns release for that position and horizon.",
    outcome:
      "Enforced per league and per position on every rail run; a target missing any of them is withheld with a stated reason, and each run records its released and withheld cells either way.",
    state: "pass",
  },
];

/**
 * Gate history. Every row was reproduced by running `validateFirstPartyRosAdmission` against the
 * corresponding report in `reports/`, so the failures are the artifacts' own, not a retelling.
 *
 * The blocker column is deliberately written in words. The superseded five-player replays are part
 * of the record and are listed, but none of their measurements may be restated here, because a
 * reader cannot tell a historical figure from a current one once both are on the page.
 */
export const rosGateHistory: readonly {
  readonly run: string;
  readonly state: string;
  readonly blockers: string;
  readonly outcome: "fail" | "pass";
}[] = [
  {
    run: "v6 — 2026-07-22",
    state: "insufficient",
    blockers:
      "Kicker coverage shortfall at the 1-4 week horizon; model and kicker identities stale.",
    outcome: "fail",
  },
  {
    run: "v7 — 2026-07-23",
    state: "insufficient",
    blockers:
      "Kicker coverage shortfall at the 1-4 week horizon; one stratum failed to converge; source lineage unavailable.",
    outcome: "fail",
  },
  {
    run: "v8, narrower sample — 2026-07-23 (Full PPR)",
    state: "evidence-ready",
    blockers: "None. Superseded by the wider-sample replay below.",
    outcome: "pass",
  },
  {
    run: "v8, narrower sample — 2026-07-28 (Half PPR, Standard)",
    state: "insufficient",
    blockers:
      "Kicker interval coverage at 1-4 weeks in both; wide receiver expected-games error at 5-8 weeks under Standard. Superseded.",
    outcome: "fail",
  },
  {
    run: "v8, current sample — 2026-07-28 (all three profiles)",
    state: "insufficient",
    blockers:
      "Quarterback expected-games error at 9+ weeks in all three; wide receiver at 5-8 weeks under Full PPR. The kicker cell no longer blocks anywhere.",
    outcome: "fail",
  },
  {
    run: "v8, catalog profiles — 2026-07-29 (Standard + 2-pt, with and without the XP-missed penalty)",
    state: "evidence-ready",
    blockers:
      "None. First runs graded under the revised availability gate; each still holds a wide receiver cell over its ceiling that the evidence test does not reject, and team-defense cells that are degenerate under a profile that does not score team defense.",
    outcome: "pass",
  },
  {
    run: "v9, D/ST-complete catalog profiles — 2026-08-04 (Standard + 2-pt, with and without the XP-missed penalty)",
    state: "insufficient",
    blockers:
      "Team-defense interval coverage at 5–8 weeks in both profiles. All other cells remain independently releasable.",
    outcome: "fail",
  },
];

/* ------------------------------------------------------------------ *
 * Rest-of-season scoring profiles
 * ------------------------------------------------------------------ */

/**
 * The profiles the rest-of-season rail has been replayed and admitted for.
 *
 * Two facts are kept deliberately separate here, because conflating them is exactly the failure
 * this page exists to prevent. `reportState` is what the replay itself concluded. `admissionState`
 * is what the production admission check then decided about that replay. At this sample they
 * disagree for every profile: every run ended `insufficient`, and every artifact was still
 * admitted, because the per-cell admission policy ratified 2026-07-22 treats a blocker matching
 * `^(?:cell|champion|calibration)_(POSITION)_(HORIZON)_` as cell-scoped rather than global. A
 * cell-scoped blocker withholds that one cell and rejects nothing else; a single global blocker
 * would have rejected the whole artifact.
 *
 * Ordering follows `ROS_SCORING_PROFILE_KEYS`, which the engine documents as load bearing.
 */
export const rosScoringProfiles: readonly RosProfileEvidence[] = [
  {
    key: "full-ppr",
    label: "Full PPR",
    shortLabel: "Full PPR",
    forecasts: 3264,
    narrowerSampleReplayed: true,
    evaluatedAt: "2026-07-28",
    reportState: "insufficient",
    reportedBlockers: [
      "calibration_QB_nine-plus_availability_mae_above_maximum",
      "calibration_WR_five-to-eight_availability_mae_above_maximum",
    ],
    withheldCells: "Quarterback, 9+ remaining weeks; wide receiver, 5–8 remaining weeks.",
    admissionState: "admissible",
    admittedAt: "2026-07-28",
    artifactChecksum: "739b8306e3f3212542d2f778575bfe741b79e8660bc27357d86064f1554996a1",
    scoringProfileDigest: "dd74455ddb551d53f68ba9420f4446aebf63e3e8ea34efd24119cc780c47a484",
  },
  {
    key: "half-ppr",
    label: "Half PPR",
    shortLabel: "Half PPR",
    forecasts: 3264,
    narrowerSampleReplayed: true,
    evaluatedAt: "2026-07-28",
    reportState: "insufficient",
    reportedBlockers: ["calibration_QB_nine-plus_availability_mae_above_maximum"],
    withheldCells: "Quarterback, 9+ remaining weeks.",
    admissionState: "admissible",
    admittedAt: "2026-07-28",
    artifactChecksum: "f419d48b31458a9f1cdf747930bda60e55cc370dad9dd8a72392e1bef5ded358",
    scoringProfileDigest: "66c5c9a41225e6b1b2fde37f680a78a450c3b098c107a8eff47e1df251c338c8",
  },
  {
    key: "standard",
    label: "Standard (non-PPR)",
    shortLabel: "Standard (non-PPR)",
    forecasts: 3264,
    narrowerSampleReplayed: true,
    evaluatedAt: "2026-07-28",
    reportState: "insufficient",
    reportedBlockers: ["calibration_QB_nine-plus_availability_mae_above_maximum"],
    withheldCells: "Quarterback, 9+ remaining weeks.",
    admissionState: "admissible",
    admittedAt: "2026-07-28",
    artifactChecksum: "2ab659edb7b376f2f29583b88846a7dcde6b22ea8db934a1aed1eefde5c4f4d6",
    scoringProfileDigest: "ecf4238506ddd4284870dcec5408b1acff501de29ee0f7662ef12f6d19a24ad0",
  },
  {
    key: "espn-standard-2pt",
    label: "Standard + 2-pt, split kicker brackets, XP-missed penalty",
    shortLabel: "Standard + 2-pt",
    forecasts: 3264,
    narrowerSampleReplayed: false,
    evaluatedAt: "2026-08-04",
    reportState: "insufficient",
    reportedBlockers: ["calibration_DST_five-to-eight_coverage_shortfall_above_maximum"],
    withheldCells: "Team defense, 5–8 remaining weeks.",
    admissionState: "admissible",
    admittedAt: "2026-08-04",
    artifactChecksum: "e870faab6d4e8c387f4b91e92bc77b6ce7e5cf0141a1c05aae7b39a2672e3adf",
    scoringProfileDigest: "6a2ce8c94a3733673f17056d2ffafc27dca00c1ab93d17ce58a1bdce9b6d6843",
  },
  {
    key: "espn-standard-2pt-nxm",
    label: "Standard + 2-pt, split kicker brackets, no XP-missed penalty",
    shortLabel: "Standard + 2-pt (no XP-missed)",
    forecasts: 3264,
    narrowerSampleReplayed: false,
    evaluatedAt: "2026-08-04",
    reportState: "insufficient",
    reportedBlockers: ["calibration_DST_five-to-eight_coverage_shortfall_above_maximum"],
    withheldCells: "Team defense, 5–8 remaining weeks.",
    admissionState: "admissible",
    admittedAt: "2026-08-04",
    artifactChecksum: "e3f5fb77c01ce377140be137de400b6f4a824ec8d741de8a2321c62450017165",
    scoringProfileDigest: "d0e49cad7fbbdf20552427d107bea2cd9a6c2f735b4d67745d5e5ca9e85832eb",
  },
];

/**
 * What changed when the replay was widened from five sampled players per position and cutoff to
 * eight. Blocker sets are `.report.blockers` in each pair of reports; the cells are named in words
 * rather than restating the superseded run's measurements, which must not appear on the page.
 *
 * The counts move in both directions, which is the point: Standard shed a blocker, Full PPR gained
 * two, and Half PPR kept one but a different one. Nothing but the sample size differed between the
 * two runs.
 *
 * This table covers only the profiles that have both generations. The two catalog profiles were
 * replayed at eight players from the start, so there is no narrower run to compare them against and
 * listing them here with an empty "before" would imply a comparison that was never made.
 */
export const rosSampleWideningRows: readonly {
  readonly profile: string;
  readonly before: string;
  readonly after: string;
  readonly change: string;
}[] = [
  {
    profile: "Full PPR",
    before: "None.",
    after: "Quarterback 9+; wide receiver 5–8.",
    change: "Zero blockers to two",
  },
  {
    profile: "Half PPR",
    before: "Kicker 1–4.",
    after: "Quarterback 9+.",
    change: "One to one, a different cell",
  },
  {
    profile: "Standard (non-PPR)",
    before: "Kicker 1–4; wide receiver 5–8.",
    after: "Quarterback 9+.",
    change: "Two blockers to one",
  },
];

/**
 * Scope facts about the widening itself, read from `.report.playersPerPosition` in both generations
 * of report. `gatesUnchanged` records that the re-validation altered no gate, threshold, tolerance,
 * or minimum in either direction — confirmed by the two ceilings and the coverage alpha in
 * `packages/projections/src/rest-of-season.ts` being the ones both generations were graded against.
 */
export const rosSampleWidening = {
  previousPlayersPerPosition: 5,
  playersPerPosition: rosPlayersPerPosition,
  gatesUnchanged: true,
} as const;

/**
 * Spelled forms of the small counts this page states in prose. Prose reads better with a word than
 * a numeral, but the word must never be typed into page copy where it could drift away from the
 * array it describes; the page indexes this list with a real `.length` instead. It runs past the
 * current profile count on purpose — new scoring profiles are validated and admitted routinely, and
 * the page must keep reading correctly when one lands.
 */
export const ROS_COUNT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
] as const;

/**
 * The per-cell admission policy that let two `insufficient` reports be admitted. Read from the
 * ratification note carried in `apps/worker/src/first-party-ros-admission.ts` (and repeated in
 * `first-party-ros-publication.ts`), alongside `CELL_BLOCKER_PATTERN`, which is what actually
 * decides whether a blocker is cell-scoped or global.
 */
export const rosCellBlockerPolicy = {
  ratifiedAt: "2026-07-22",
  source: "apps/worker/src/first-party-ros-admission.ts",
} as const;

/**
 * What a backtest cell blocker does and does not commit to, read from the two modules that decide
 * it. Stated precisely because the honest version is narrower than "blocked forever" and narrower
 * than "re-checked, so it might publish anyway".
 *
 * - `first-party-ros-admission.ts` records that `insufficient` is acceptable only when it is
 *   explained entirely by per-cell blockers "the release gate will re-evaluate", and returns them
 *   as `cellBlockers` instead of rejecting the artifact.
 * - `first-party-ros-publication.ts` then evaluates `evaluateFirstPartyRosReleaseGate` once per
 *   position/horizon and records `cellDecisions` for every bucket, released and withheld alike.
 * - The same module's `admittedCellBlockers` reads the admitted report's own blockers and overrides
 *   a releasing gate for those cells, so a cell this artifact blocked stays withheld while this
 *   artifact is the admitted one. It clears when a later replay stops naming it, which is exactly
 *   what happened to the kicker cell at 1–4 weeks.
 */
export const rosCellBlockerLifecycle = {
  reEvaluatedAtPublication: true,
  decisionsRecordedPerCell: "cellDecisions",
  admittedBlockersOverrideReleasingGate: true,
  admissionSource: "apps/worker/src/first-party-ros-admission.ts",
  publicationSource: "apps/worker/src/first-party-ros-publication.ts",
} as const;

/**
 * The scope every current profile shares. Each value below is identical in all five reports and
 * was checked in each of them.
 */
export const rosSharedReplayScope = {
  /** `.coverage.completeAsOfBatches` / `.totalAsOfBatches` */
  batches: 68,
  /** `.report.cells` */
  cells: 18,
  /** `.report.convergenceAudit`, every entry `converged` */
  convergenceDiagnostics: 144,
} as const;

/**
 * Every cell that blocks, plus the cells sitting closest to their ceilings, read from each
 * report's own evidence rather than restated.
 *
 * The quantities are not comparable across rows without their ceilings, so each row carries the one
 * it was judged against: 1.5 games for the 1–4 and 5–8 windows, 2.75 for 9+. The wide receiver rows
 * appear for every profile because the same cell blocks under one and clears under the rest, and
 * publishing only the failure would hide how narrow that is. The kicker rows are the coverage gate,
 * so what matters is the covered-block count and not a rate; those two cells blocked at the
 * narrower sample and no longer do.
 *
 * Both gates now weigh their evidence the same way — an exact-binomial one-sided test, coverage
 * against a 60% floor for the nominal 70% interval and expected-games error against the ceiling for
 * its own horizon (`rosAvailabilityGate`). The blocked/not-blocked verdicts recorded below are the
 * ones these reports carry, raised under the availability gate's superseded point comparison.
 */
export const rosWithheldCellFigures: readonly EvidenceFigure[] = [
  {
    label: "Full PPR — quarterback, 9+ weeks: expected-games error",
    value: "2.8091 games against a 2.75-game ceiling — blocked, over by 0.0591",
    source:
      "ros-validation-v8-full-ppr-n8 .availabilityAudit[QB, nine-plus].expectedGamesRowMae vs FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE",
  },
  {
    label: "Half PPR — quarterback, 9+ weeks: expected-games error",
    value: "2.8057 games against a 2.75-game ceiling — blocked, over by 0.0557",
    source:
      "ros-validation-v8-half-ppr-n8 .availabilityAudit[QB, nine-plus].expectedGamesRowMae vs FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE",
  },
  {
    label: "Standard — quarterback, 9+ weeks: expected-games error",
    value: "2.7638 games against a 2.75-game ceiling — blocked, over by 0.0138",
    source:
      "ros-validation-v8-standard-n8 .availabilityAudit[QB, nine-plus].expectedGamesRowMae vs FIRST_PARTY_ROS_MAX_NINE_PLUS_AVAILABILITY_MAE",
  },
  {
    label: "Full PPR — wide receiver, 5–8 weeks: expected-games error",
    value: "1.5399 games against a 1.5-game ceiling — blocked, over by 0.0399",
    source:
      "ros-validation-v8-full-ppr-n8 .availabilityAudit[WR, five-to-eight].expectedGamesRowMae vs FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE",
  },
  {
    label: "Standard — wide receiver, 5–8 weeks: expected-games error",
    value: "1.4912 games against a 1.5-game ceiling — not blocked, under by 0.0088",
    source:
      "ros-validation-v8-standard-n8 .availabilityAudit[WR, five-to-eight].expectedGamesRowMae vs FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE",
  },
  {
    label: "Half PPR — wide receiver, 5–8 weeks: expected-games error",
    value: "1.3755 games against a 1.5-game ceiling — not blocked, under by 0.1245",
    source:
      "ros-validation-v8-half-ppr-n8 .availabilityAudit[WR, five-to-eight].expectedGamesRowMae vs FIRST_PARTY_ROS_MAX_AVAILABILITY_MAE",
  },
  {
    label: "Half PPR — kicker, 1–4 weeks: walk-forward blocks covered",
    value: "3 of 4 — not blocked",
    source:
      "ros-validation-v8-half-ppr-n8 .champion.choices[K, one-to-four].walkForwardCalibration.observedBlockCoverage / .blocks",
  },
  {
    label: "Standard — kicker, 1–4 weeks: walk-forward blocks covered",
    value: "2 of 4 — not blocked",
    source:
      "ros-validation-v8-standard-n8 .champion.choices[K, one-to-four].walkForwardCalibration.observedBlockCoverage / .blocks",
  },
  {
    label: "Standard + 2-pt — team defense, 5–8 weeks: walk-forward blocks covered",
    value: "0 of 4 — blocked, despite 8.73% lower point error than baseline",
    source:
      "ros-validation-v9-espn-standard-2pt-n8 .champion.choices[DST, five-to-eight].walkForwardCalibration / .modelImprovement",
  },
  {
    label: "Standard + 2-pt (no XP-missed) — team defense, 5–8 weeks: walk-forward blocks covered",
    value: "0 of 4 — blocked, despite 8.74% lower point error than baseline",
    source:
      "ros-validation-v9-espn-standard-2pt-nxm-n8 .champion.choices[DST, five-to-eight].walkForwardCalibration / .modelImprovement",
  },
];

/* ------------------------------------------------------------------ *
 * Weekly model
 * ------------------------------------------------------------------ */

/**
 * Release-gate thresholds for the weekly model, read from the running code rather than from any
 * report. These are requirements, not results — see `weeklyEvidenceState` for why no weekly
 * accuracy figure is published here.
 */
export const weeklyGateRows: readonly ReleaseGateRow[] = [
  {
    gate: "Player sample floor",
    requirement: "At least 100 scored player outcomes before any position may publish.",
    outcome: "Enforced on every sweep; a short sample rejects the set.",
    state: "pass",
  },
  {
    gate: "Team-defense sample floor",
    requirement: "At least 48 scored D/ST outcomes.",
    outcome: "Enforced on every sweep; a short sample rejects the set.",
    state: "pass",
  },
  {
    gate: "Interval calibration",
    requirement: "Observed coverage of the nominal 70% interval must fall between 62% and 78%.",
    outcome: "Enforced on at least 100 interval samples.",
    state: "pass",
  },
  {
    gate: "Point bias",
    requirement:
      "Absolute bias must stay within 15% of the model's own error, floored at 0.5 and capped at 1.0 points.",
    outcome: "Enforced per position on every sweep.",
    state: "pass",
  },
  {
    gate: "Challenger promotion",
    requirement:
      "A richer model replaces the recency baseline only with at least 2% lower error across at least 100 outcomes and 8 completed week batches.",
    outcome: "Enforced per position; otherwise the baseline defends.",
    state: "pass",
  },
];

/**
 * Provenance of the weekly accuracy figures.
 *
 * The weekly validator writes its result to standard output and persists no artifact, so there was
 * no stored record to cite. The official audit was therefore re-run for this page —
 * `npm run projections:validate -w @fantasy/worker -- --summary`, completed 2026-07-27, exit 0 —
 * and its output is checked in beside this module as `weekly-validation-2026-07-27.json`. Every
 * weekly figure below is read from that file, which any reader holding the repository can
 * regenerate with the same command.
 *
 * Note for maintainers: the reproduced run does not agree with the weekly paragraph in
 * `docs/operations.md`. That prose reports MAE 4.4065, bias -0.1074, coverage 71.02%, and model
 * version v7; the audit actually produces 4.4032, -0.1077, 71.04%, and `laces-weekly-components-v8`.
 * The published values here follow the audit, not the prose.
 */
export const weeklyArtifact = {
  /** `.generatedAt` */
  evaluatedAt: "2026-07-27",
  /** `.player.policy.modelVersion` */
  modelVersion: "laces-weekly-components-v8",
  /** `.gate.state` */
  gateState: "publishable",
  /** `.gate.reasons` */
  gateReasons: 0,
  /** `.player.policy.generatedThrough` */
  evidenceThrough: "2025 week 18",
  artifactFile: "weekly-validation-2026-07-27.json",
  command: "npm run projections:validate -w @fantasy/worker -- --summary",
} as const;

/** Evaluated seasons, read from `.seasons`. */
export const weeklySeasons = [2023, 2024, 2025] as const;

export const weeklyScopeFigures: readonly EvidenceFigure[] = [
  {
    label: "Seasons replayed",
    value: "3 (2023, 2024, 2025)",
    source: "weekly-validation .seasons",
  },
  {
    label: "Player forecasts graded",
    value: "9,261",
    source: "weekly-validation .player.predictions",
  },
  {
    label: "Team-defense forecasts graded",
    value: "1,632",
    source: "weekly-validation .defense.predictions",
  },
  {
    label: "Player error (MAE)",
    value: "4.4032 points",
    source: "weekly-validation .player.championOverall.mae",
  },
  {
    label: "Player bias",
    value: "-0.1077 points",
    source: "weekly-validation .player.championOverall.bias",
  },
  {
    label: "Player interval coverage (nominal 70%)",
    value: "71.04% on 8,746 samples",
    source: "weekly-validation .player.championOverall.intervalCoverage",
  },
  {
    label: "Team-defense error (MAE)",
    value: "4.3193 vs 4.5309 baseline",
    source: "weekly-validation .defense.overall.mae / .baselineMae",
  },
  {
    label: "Team-defense interval coverage (nominal 70%)",
    value: "71.69% on 1,600 samples",
    source: "weekly-validation .defense.overall.intervalCoverage",
  },
];

/** Per-position results, read from `.player.byPosition` in the checked-in audit. */
export const weeklyPositionRows: readonly {
  readonly position: string;
  readonly samples: string;
  readonly mae: string;
  readonly coverage: string;
}[] = [
  { position: "QB", samples: "1,100", mae: "6.5641", coverage: "71.85%" },
  { position: "RB", samples: "2,054", mae: "4.4545", coverage: "68.66%" },
  { position: "WR", samples: "3,396", mae: "4.3202", coverage: "72.78%" },
  { position: "TE", samples: "2,026", mae: "3.3260", coverage: "70.36%" },
  { position: "K", samples: "685", mae: "4.3772", coverage: "70.19%" },
];

/**
 * Which model actually won. `.player.qualifiedCandidatePositions` is empty and
 * `.player.fallbackPositions` lists all five, so the richer contextual candidate did not clear the
 * 2% promotion margin at any position and the simpler recency baseline defends everywhere. Team
 * defense is the exception: `.defense.overall.beatsBaseline` is true.
 */
export const weeklyChampionOutcome = {
  playerPositionsDefendedByBaseline: 5,
  playerPositionsWonByRicherModel: 0,
  /** `.player.candidateOverall.improvement` — real, but below the 2% bar. */
  richerCandidateImprovement: "0.30%",
  /** `.defense.overall.improvement` */
  defenseImprovement: "4.67%",
} as const;

export const weeklyEvidenceState = {
  publishesAccuracyFigures: true,
  reason:
    "The weekly validator stores no artifact, so its official audit was re-run and the output checked in beside this manifest.",
  gateSource: "apps/worker/src/first-party-projections.ts, packages/projections/src/first-party.ts",
} as const;
