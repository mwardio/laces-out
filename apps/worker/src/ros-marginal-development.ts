import { createHash } from "node:crypto";
import { NFL_TEAMS } from "@laces-out/domain";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
  rosProfileDefinitionFromKey,
  isRosScoringProfileKey,
  rosScoringProfile,
  applyFirstPartyRosIntervalCalibration,
  compareMarginalIntervalCell,
  compareMarginalIntervalPortfolio,
  evaluateFirstPartyRosChampionPolicy,
  evaluateRetainedV12FirstPartyRosChampionPolicy,
  evaluateFirstPartyRosMarginalPolicy,
  buildRosMarginalIntervalQualificationSet,
  buildFrozenRosBenchmark,
  type FrozenRosBenchmarkInput,
  type RosMarginalQualificationDataset,
  validateMarginalRosTrainingCohort,
  type FirstPartyRosChampionOptions,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosHeldOutSeason,
  type FirstPartyRosPosition,
  type FirstPartyRosRemainingWeeksBucket,
  type FirstPartyRosStrategy,
  type MarginalIntervalComparisonRow,
  type MarginalIntervalComparisonSource,
  type MarginalRosCandidateEvaluation,
} from "@laces-out/projections";
import { firstPartyRosChampionPolicyChecksum } from "./first-party-ros-publication.js";
import {
  validateRosDerivedEvaluation,
  type RosDerivedEvaluationInput,
} from "./ros-derived-evaluation.js";

export const ROS_MARGINAL_DEVELOPMENT_VERSION = "pinned-report-marginal-development-v1";
export const ROS_MARGINAL_TRAINING_DEVELOPMENT_VERSION =
  "pinned-report-marginal-development-separate-defense-training-v2";
export const ROS_MARGINAL_QUALIFIED_DEVELOPMENT_VERSION =
  "pinned-report-marginal-development-qualification-v3";
export const ROS_MARGINAL_COMPOSITE_TRAINING_VERSION =
  "full-portfolio-audit-and-complete-defense-training-v1";
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
const BUCKETS = ["one-to-four", "five-to-eight", "nine-plus"] as const;
const SOURCE_FIELDS = [
  "weeklyStatsChecksum",
  "playerWeeklyRawChecksum",
  "playerTouchdownPlayByPlayChecksum",
  "teamWeeklyStatsChecksum",
  "weeklyRosterChecksum",
  "injuryChecksum",
  "snapChecksum",
  "scheduleChecksum",
] as const;

function fail(message: string): never {
  throw new Error(`Marginal ROS report: ${message}`);
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("missing report object");
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum = 20_000): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maximum ||
    Object.keys(value).length !== value.length
  )
    fail("missing or invalid report array");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    fail("invalid report count/season");
  return Number(value);
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    fail("invalid provenance checksum");
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("undefined proof field");
  return encoded;
}
function equal(a: unknown, b: unknown, label: string): void {
  if (canonical(a) !== canonical(b)) fail(label);
}
function bucket(row: {
  windowStartWeek: number;
  windowEndWeek: number;
}): FirstPartyRosRemainingWeeksBucket {
  const weeks = row.windowEndWeek - row.windowStartWeek + 1;
  return weeks <= 4 ? "one-to-four" : weeks <= 8 ? "five-to-eight" : "nine-plus";
}
function candidateKey(strategy: FirstPartyRosStrategy) {
  return strategy === "contextual" ? "contextual" : "recency";
}

function pinnedJson(value: string, checksum: string): unknown {
  digest(checksum);
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > 64 * 1024 * 1024 ||
    createHash("sha256").update(value).digest("hex") !== checksum
  )
    fail("report bytes do not match pinned SHA256");
  return JSON.parse(value) as unknown;
}

const OPTION_KEYS = [
  "minimumHeldOutSeasons",
  "minimumBatches",
  "minimumSamples",
  "minimumCellSeasons",
  "minimumCellSamples",
  "minimumCellCutoffs",
  "minimumCellBatches",
  "minimumModelImprovement",
] as const;
const LOCKED_OPTIONS: FirstPartyRosChampionOptions = {
  minimumHeldOutSeasons: 3,
  minimumBatches: 30,
  minimumSamples: 300,
  minimumCellSeasons: 3,
  minimumCellSamples: 18,
  minimumCellCutoffs: 3,
  minimumCellBatches: 9,
  minimumModelImprovement: 0.01,
};
const HELD_OUT_SEASONS = [2022, 2023, 2024, 2025];
const SOURCE_SEASONS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];

/** Parse complete, hash-pinned CLI evidence and reconstruct every executable v7 policy field. */
function snapshot(
  value: unknown,
  reportChecksum: string,
  previous: boolean,
  role: "audit8" | "interval-training32" = "audit8",
) {
  digest(reportChecksum);
  const root = record(value),
    report = record(root.report),
    diagnostics = record(root.diagnostics);
  const scope = record(root.validationScope),
    coverage = record(root.coverage),
    policy = record(root.publicationPolicy);
  const modelVersion = previous ? "laces-ros-distribution-v12" : FIRST_PARTY_ROS_MODEL_VERSION;
  if (
    root.validationMode !== "read-only-first-party-ros-backtest" ||
    root.noDatabaseWrites !== true ||
    root.sourcePolicy !== "official-nflverse-artifacts" ||
    policy.modelVersion !== modelVersion ||
    policy.policyVersion !== FIRST_PARTY_ROS_POLICY_VERSION ||
    coverage.state !== "qualified" ||
    !["evidence-ready", "insufficient"].includes(String(report.state))
  )
    fail("unrecognized or incomplete legacy report");
  const positions = array(scope.positions, 6) as FirstPartyRosPosition[];
  if (
    new Set(positions).size !== positions.length ||
    positions.some((position) => !POSITIONS.includes(position))
  )
    fail("invalid report positions");
  if (scope.completePortfolio !== (positions.length === 6)) fail("inconsistent portfolio scope");
  if (role === "interval-training32")
    equal(positions, ["DST"], "interval training requires the complete defense-only cohort");
  const playersPerPosition = role === "interval-training32" ? 32 : 8;
  const seasons = array(report.seasons, 201).map((value) => integer(value, 2000, 2200));
  equal(seasons, HELD_OUT_SEASONS, "changed frozen held-out seasons");
  equal(
    report.leakagePolicy,
    {
      calibration: "seasons-strictly-before-heldout",
      features: "strictly-before-cutoff",
      futureRosterUse: false,
      targetOutcomeUse: "evaluation-only",
    },
    "changed forecast leakage policy",
  );
  if (seasons.length < 3 || seasons.some((season, i) => i > 0 && season <= seasons[i - 1]!))
    fail("incomplete or unordered held-out seasons");
  equal(coverage.fullyHeldOutSeasons, seasons, "held-out source coverage mismatch");
  const batches = seasons.length * 17;
  if (
    report.batches !== batches ||
    coverage.completeAsOfBatches !== batches ||
    coverage.totalAsOfBatches !== batches ||
    report.playersPerPosition !== playersPerPosition ||
    report.maximumForecasts !== 6000 ||
    report.skippedForecasts !== 0
  )
    fail("incomplete locked release cohort");
  const raw = array(
    diagnostics.candidateForecasts,
  ) as unknown as readonly FirstPartyRosHeldOutForecast[];
  if (
    raw.length !== positions.length * seasons.length * 17 * playersPerPosition ||
    report.forecasts !== raw.length
  )
    fail("incomplete forecast count");
  const counts = new Map<string, Set<string>>();
  const convergence = new Map<string, Record<string, unknown>>();
  for (const audit of array(report.convergenceAudit, 6 * 4 * 3 * 2)) {
    const entry = record(audit);
    if (
      !seasons.includes(Number(entry.season)) ||
      !positions.includes(entry.position as FirstPartyRosPosition) ||
      !BUCKETS.includes(entry.bucket as FirstPartyRosRemainingWeeksBucket) ||
      !["contextual", "availability-aware-recency"].includes(String(entry.strategy)) ||
      !["converged", "unstable"].includes(String(entry.state)) ||
      typeof entry.worstToleranceRatio !== "number" ||
      !Number.isFinite(entry.worstToleranceRatio) ||
      entry.worstToleranceRatio < 0 ||
      (entry.state === "converged") !== entry.worstToleranceRatio <= 1
    )
      fail("invalid physical convergence audit");
    const key = `${String(entry.season)}:${String(entry.position)}:${String(entry.bucket)}:${String(entry.strategy)}`;
    if (convergence.has(key)) fail("duplicate physical convergence stratum");
    convergence.set(key, entry);
  }
  if (
    convergence.size !== seasons.length * positions.length * 3 * 2 ||
    report.diagnosedPairs !== convergence.size / 2
  )
    fail("incomplete physical convergence audit");
  for (const forecast of raw) {
    if ((forecast.position === "DST") !== forecast.playerId.startsWith("DST:"))
      fail("defense player identity and position disagree");
    if (
      !positions.includes(forecast.position) ||
      !seasons.includes(forecast.forecastSeason) ||
      forecast.asOfWeek < 1 ||
      forecast.asOfWeek > 17 ||
      forecast.windowStartWeek !== forecast.asOfWeek + 1 ||
      forecast.windowEndWeek !== 18
    )
      fail("unexpected forecast scope/window");
    if (
      forecast.trainedThroughSeason !== forecast.forecastSeason - 1 ||
      forecast.contextualModelVersion !==
        `${modelVersion}:contextual:laces-weekly-components-v15` ||
      forecast.recencyModelVersion !==
        `${modelVersion}:availability-aware-recency:laces-weekly-components-v15` ||
      forecast.intervalMethodVersion !== "simulation-p15-p50-p85-cqr-v1"
    )
      fail("forecast lineage/chronology mismatch");
    const availability = forecast.evidence.availability;
    integer(availability.scheduledGames, 1, Math.min(17, 18 - forecast.asOfWeek));
    if (
      forecast.position === "DST" &&
      (availability.actualGames !== availability.scheduledGames ||
        availability.contextualExpectedGames !== availability.scheduledGames ||
        availability.recencyExpectedGames !== availability.scheduledGames)
    )
      fail("defense schedule support is not deterministic");
    if (forecast.position === "DST")
      equal(
        forecast.evidence.coverage,
        { contextual: 1, recency: 1 },
        "incomplete defense input coverage",
      );
    for (const strategy of ["contextual", "availability-aware-recency"] as const) {
      const audit = convergence.get(
        `${forecast.forecastSeason}:${forecast.position}:${bucket(forecast)}:${strategy}`,
      );
      if (!audit || forecast.evidence.convergence[candidateKey(strategy)].state !== audit.state)
        fail("forecast/stratum convergence mismatch");
    }
    const key = `${forecast.forecastSeason}:${forecast.asOfWeek}:${forecast.position}`;
    const players = counts.get(key) ?? new Set<string>();
    if (players.has(forecast.playerId)) fail("duplicate cohort player");
    players.add(forecast.playerId);
    counts.set(key, players);
  }
  if (
    counts.size !== positions.length * batches ||
    [...counts.values()].some((players) => players.size !== playersPerPosition)
  )
    fail("missing cutoff/player support");
  if (
    role === "interval-training32" &&
    [...counts.values()].some((players) => NFL_TEAMS.some((team) => !players.has(`DST:${team}`)))
  )
    fail("interval training requires all 32 canonical defense identities at every cutoff");
  const heldOutSeasons: FirstPartyRosHeldOutSeason[] = seasons.map((season) => ({
    season,
    complete: true,
    forecasts: raw.filter((row) => row.forecastSeason === season),
  }));
  const options = Object.fromEntries(
    OPTION_KEYS.map((key) => [key, policy[key]]),
  ) as FirstPartyRosChampionOptions;
  equal(options, LOCKED_OPTIONS, "changed mean-selector thresholds");
  // The retained evaluator constructs its own v12 policies and verifies authentic row lineage.
  // Never relabel current-model policy output to make a previous-model comparison appear valid.
  const legacy = previous
    ? evaluateRetainedV12FirstPartyRosChampionPolicy(heldOutSeasons, options)
    : evaluateFirstPartyRosChampionPolicy(heldOutSeasons, options);
  equal(legacy.livePolicy, policy, "reconstructed v7 executable policy mismatch");
  if (
    record(root.champion).publicationPolicyChecksum !==
    firstPartyRosChampionPolicyChecksum(legacy.livePolicy)
  )
    fail("legacy policy checksum mismatch");
  equal(diagnostics.selected, legacy.selected, "chronological selected means/ranges mismatch");
  equal(
    diagnostics.seasonPolicies,
    legacy.seasonPolicies.map((audit) => ({
      season: audit.season,
      evidenceThroughSeason: audit.evidenceThroughSeason,
      choices: audit.policy.choices
        .filter((choice) => positions.includes(choice.position))
        .map((choice) => ({
          position: choice.position,
          bucket: choice.bucket,
          strategy: choice.strategy,
          reason: choice.reason,
          contextualCalibration: choice.intervalCalibrationArtifacts.contextual,
          recencyCalibration: choice.intervalCalibrationArtifacts.recency,
        })),
    })),
    "chronological legacy policy mismatch",
  );
  const identity = legacy.livePolicy.evidenceIdentity;
  if (!identity) fail("missing source identity");
  const reportedProfile = record(root.scoringProfile);
  const profile = isRosScoringProfileKey(reportedProfile.key)
    ? rosScoringProfile(reportedProfile.key)
    : rosProfileDefinitionFromKey(identity.scoringProfileKey);
  if (profile.scoringProfileKey !== identity.scoringProfileKey)
    fail("named scoring profile differs from scored rules");
  equal(
    root.scoringProfile,
    { key: profile.key, label: profile.label, digest: profile.digest },
    "scoring profile metadata mismatch",
  );
  equal(
    root.identityAudit,
    {
      inputChecksums: new Set(raw.map((row) => row.inputChecksum)).size,
      contextualConvergenceChecksums: new Set(
        raw.map((row) => row.evidence.convergence.contextual.diagnosticChecksum),
      ).size,
      recencyConvergenceChecksums: new Set(
        raw.map((row) => row.evidence.convergence.recency.diagnosticChecksum),
      ).size,
      ...identity,
    },
    "forecast identity audit mismatch",
  );
  const sources = array(root.sources, 201).map(record);
  const sourceSeasons = sources.map((row) => integer(row.season, 2000, 2200));
  equal(sourceSeasons, SOURCE_SEASONS, "changed frozen source seasons");
  if (
    new Set(sourceSeasons).size !== sourceSeasons.length ||
    seasons.some(
      (season) =>
        !sourceSeasons.includes(season) ||
        sourceSeasons.filter((prior) => prior < season).length < 3,
    )
  )
    fail("incomplete source seasons");
  for (const entry of sources) for (const key of SOURCE_FIELDS) digest(entry[key]);
  const blockers =
    Array.isArray(report.blockers) && report.blockers.every((v) => typeof v === "string")
      ? report.blockers
      : fail("missing legacy blockers");
  if ((report.state === "evidence-ready") !== (blockers.length === 0))
    fail("inconsistent legacy blocker state");
  return {
    root,
    report,
    positions,
    seasons,
    raw,
    heldOutSeasons,
    options,
    legacy,
    sources,
    blockers,
    physicalBlockers: [...convergence.entries()]
      .filter(([, entry]) => entry.state !== "converged")
      .map(([key]) => `physical-convergence:${key}`),
    source: {
      modelVersion,
      policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
      scoringProfileKey: identity.scoringProfileKey,
      physicalCorpusChecksum: digest(root.outcomeCorpusIdentity),
      reportChecksum,
    } satisfies MarginalIntervalComparisonSource,
  };
}

/**
 * A derived corpus is not an alias for either physical constituent. Retain an inspectable,
 * content-addressed composition manifest, including the exact scored row digests and both
 * convergence audits. Non-defense rows are copied from the audit without changing their data;
 * the shared superset validator independently checks every original defense input and target.
 */
function composePortfolioTraining(
  candidate: ReturnType<typeof snapshot>,
  training: ReturnType<typeof snapshot>,
) {
  equal(
    [...candidate.positions].sort(),
    [...POSITIONS].sort(),
    "incomplete training composition audit",
  );
  const nonDefenseSeasons = candidate.heldOutSeasons.map((season) => ({
    ...season,
    forecasts: season.forecasts.filter((row) => row.position !== "DST"),
  }));
  const heldOutSeasons = candidate.heldOutSeasons.map((season) => ({
    ...season,
    forecasts: [
      ...season.forecasts.filter((row) => row.position !== "DST"),
      ...training.heldOutSeasons.find((year) => year.season === season.season)!.forecasts,
    ],
  }));
  const checked = validateMarginalRosTrainingCohort(candidate.heldOutSeasons, heldOutSeasons);
  const rowsChecksum = (seasons: readonly FirstPartyRosHeldOutSeason[]) =>
    validateMarginalRosTrainingCohort(seasons, seasons).provenance.evaluationRowsChecksum;
  if (
    checked.provenance.evaluationForecasts !== 3264 ||
    checked.provenance.trainingForecasts !== 4896 ||
    checked.provenance.additionalTrainingForecasts !== 1632
  )
    fail("incomplete frozen training composition");
  const checksum = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
  const manifest = {
    schemaVersion: 1,
    version: ROS_MARGINAL_COMPOSITE_TRAINING_VERSION,
    seasons: candidate.seasons,
    sourceManifestChecksum: checksum(candidate.sources),
    evaluation: {
      source: candidate.source,
      rowsChecksum: checked.provenance.evaluationRowsChecksum,
      forecasts: 3264,
    },
    constituents: [
      {
        role: "unchanged-non-defense-audit",
        source: candidate.source,
        positions: POSITIONS.filter((position) => position !== "DST"),
        sourceRowsChecksum: checked.provenance.evaluationRowsChecksum,
        selectedRowsChecksum: rowsChecksum(nonDefenseSeasons),
        forecasts: 2720,
        convergenceAuditChecksum: checksum(candidate.report.convergenceAudit),
      },
      {
        role: "complete-defense-training",
        source: training.source,
        positions: ["DST"],
        sourceRowsChecksum: rowsChecksum(training.heldOutSeasons),
        selectedRowsChecksum: rowsChecksum(training.heldOutSeasons),
        forecasts: 2176,
        convergenceAuditChecksum: checksum(training.report.convergenceAudit),
      },
    ],
    trainingForecasts: checked.provenance.trainingForecasts,
    trainingRowsChecksum: checked.provenance.trainingRowsChecksum,
  } as const;
  const source = {
    ...candidate.source,
    // Domain separation distinguishes the derived corpus identity from the manifest report pin.
    physicalCorpusChecksum: checksum({ kind: "derived-training-corpus", manifest }),
    reportChecksum: checksum(manifest),
  };
  return { source, heldOutSeasons: checked.ordered, manifest };
}

export interface PinnedRosMarginalDevelopmentInput {
  readonly candidateReportJson: string;
  readonly candidateReportChecksum: string;
  readonly previousReportJson: string;
  readonly previousReportChecksum: string;
  readonly intervalTrainingReportJson?: string;
  readonly intervalTrainingReportChecksum?: string;
  readonly forecastSeason: number;
  readonly evaluationSeason: number;
  readonly positions: readonly FirstPartyRosPosition[];
  /** Explicit frozen protocol binding; absence preserves the original report byte identity. */
  readonly qualificationProtocolChecksum?: string;
  /** Explicit corrected-truth comparison; original forecast sources remain separately pinned. */
  readonly derivedEvaluation?: RosDerivedEvaluationInput;
}

/** Shared pinned-input authentication only; no marginal or conditional candidate is fitted here. */
export function parsePinnedRosMarginalDevelopmentInputs(input: PinnedRosMarginalDevelopmentInput) {
  integer(input.forecastSeason, 2000, 2200);
  integer(input.evaluationSeason, 2000, 2200);
  if (input.qualificationProtocolChecksum !== undefined)
    digest(input.qualificationProtocolChecksum);
  if (
    (input.intervalTrainingReportJson === undefined) !==
    (input.intervalTrainingReportChecksum === undefined)
  )
    fail("interval training report and pinned SHA256 must be supplied together");
  const derivedEvaluation =
    input.derivedEvaluation === undefined
      ? null
      : validateRosDerivedEvaluation({
          input: input.derivedEvaluation,
          candidateReportJson: input.candidateReportJson,
          candidateReportChecksum: input.candidateReportChecksum,
          previousReportJson: input.previousReportJson,
          previousReportChecksum: input.previousReportChecksum,
          intervalTrainingReportJson: input.intervalTrainingReportJson!,
          intervalTrainingReportChecksum: input.intervalTrainingReportChecksum!,
        });
  const candidate = snapshot(
    pinnedJson(input.candidateReportJson, input.candidateReportChecksum),
    input.candidateReportChecksum,
    false,
  );
  let previous = snapshot(
    pinnedJson(input.previousReportJson, input.previousReportChecksum),
    input.previousReportChecksum,
    true,
  );
  if (
    derivedEvaluation === null &&
    (Object.hasOwn(candidate.root, "correctedComparison") ||
      Object.hasOwn(previous.root, "correctedComparison"))
  )
    fail("derived comparisons require their original forecast and corrected observation lineage");
  const originalPrevious =
    derivedEvaluation === null
      ? null
      : snapshot(
          derivedEvaluation.originalPreviousReport,
          input.derivedEvaluation!.originalPreviousReportChecksum,
          true,
        );
  let frozenPrevious: FrozenRosBenchmarkInput | null = null;
  const previousCounterfactual = originalPrevious === null ? null : previous;
  if (originalPrevious !== null) {
    const dataset = (value: typeof previous): RosMarginalQualificationDataset => ({
      source: value.source,
      sourceManifestChecksum: createHash("sha256").update(canonical(value.sources)).digest("hex"),
      heldOutSeasons: value.heldOutSeasons,
      rowsChecksum: validateMarginalRosTrainingCohort(value.heldOutSeasons, value.heldOutSeasons)
        .provenance.evaluationRowsChecksum,
    });
    frozenPrevious = {
      original: dataset(originalPrevious),
      comparisonManifestChecksum: input.derivedEvaluation!.comparisonManifestChecksum,
    };
    const frozen = buildFrozenRosBenchmark(frozenPrevious, dataset(previous), previous.options);
    equal(frozen.evaluation, originalPrevious.legacy, "original previous policy was not preserved");
    previous = { ...previous, legacy: frozen.evaluation };
  }
  const training =
    input.intervalTrainingReportJson === undefined
      ? null
      : snapshot(
          pinnedJson(input.intervalTrainingReportJson, input.intervalTrainingReportChecksum!),
          input.intervalTrainingReportChecksum!,
          false,
          "interval-training32",
        );
  if (candidate.source.physicalCorpusChecksum === previous.source.physicalCorpusChecksum)
    fail("different physical model versions cannot share one corpus identity");
  equal(candidate.seasons, previous.seasons, "candidate/previous held-out seasons differ");
  equal(candidate.sources, previous.sources, "candidate/previous source checksums differ");
  if (candidate.source.scoringProfileKey !== previous.source.scoringProfileKey)
    fail("candidate/previous scoring profile differs");
  if (
    input.evaluationSeason !== candidate.seasons.at(-1) ||
    input.forecastSeason <= input.evaluationSeason
  )
    fail("evaluation must use latest declared held-out season before live forecast");
  const positions = [...input.positions].sort();
  if (
    positions.length === 0 ||
    new Set(positions).size !== positions.length ||
    positions.some(
      (position) =>
        !POSITIONS.includes(position) ||
        !candidate.positions.includes(position) ||
        !previous.positions.includes(position),
    )
  )
    fail("invalid comparison scope");
  // Current repaired v13 report must be graded in its entirety; a wider old report can supply the
  // corresponding previous deployment cells. No failing candidate position may be omitted.
  equal(positions, [...candidate.positions].sort(), "comparison omits candidate positions");
  if (training !== null) {
    if (positions.length !== 6)
      equal(
        positions,
        ["DST"],
        "separate interval training requires a defense-only or complete audit",
      );
    equal(training.seasons, candidate.seasons, "interval training/audit held-out seasons differ");
    equal(training.sources, candidate.sources, "interval training/audit source checksums differ");
    if (
      training.source.modelVersion !== candidate.source.modelVersion ||
      training.source.scoringProfileKey !== candidate.source.scoringProfileKey
    )
      fail("interval training/audit model or scoring profile differs");
    if (
      training.source.physicalCorpusChecksum === candidate.source.physicalCorpusChecksum ||
      training.source.physicalCorpusChecksum === previous.source.physicalCorpusChecksum
    )
      fail("separate interval training requires a distinct physical corpus identity");
  }
  const composite =
    training !== null && positions.length === 6
      ? composePortfolioTraining(candidate, training)
      : null;
  const intervalTraining = composite ?? training;
  const commonKey = (row: FirstPartyRosHeldOutForecast, old: boolean) =>
    JSON.stringify([
      row.position,
      row.forecastSeason,
      row.asOfWeek,
      old && row.position === "DST" && row.playerId === "DST:LA" ? "DST:LAR" : row.playerId,
    ]);
  const oldRows = new Map<string, FirstPartyRosHeldOutForecast>();
  for (const row of previous.raw.filter((row) => positions.includes(row.position))) {
    const key = commonKey(row, true);
    if (oldRows.has(key)) fail("previous canonical identity collision");
    oldRows.set(key, row);
  }
  if (oldRows.size !== candidate.raw.length) fail("all-season cohort size mismatch");
  for (const row of candidate.raw) {
    if (row.playerId === "DST:LA") fail("repaired candidate contains legacy Rams identity");
    const old = oldRows.get(commonKey(row, false));
    if (!old) fail("all-season cohort identity mismatch");
    const observed = (r: FirstPartyRosHeldOutForecast) => [
      r.windowStartWeek,
      r.windowEndWeek,
      r.evidence.availability.scheduledGames,
      r.evidence.availability.actualGames,
      r.actualPoints,
    ];
    equal(observed(row), observed(old), "all-season outcome/schedule mismatch");
  }
  return {
    candidate,
    previous,
    training,
    composite,
    intervalTraining,
    positions,
    originalPrevious,
    previousCounterfactual,
    frozenPrevious,
    derivedEvaluation,
  };
}

/** Keep physical failures from the declared training source; preserve unknown failure reasons. */
export function scopedRosTrainingConvergenceBlockers(
  blockers: readonly string[],
  positions: readonly FirstPartyRosPosition[],
): readonly string[] {
  return blockers.filter((reason) => {
    if (!reason.includes("convergence")) return false;
    // Native DST-only reports retain the global policy's missing-position diagnostics. Those
    // placeholders do not describe the independently authenticated non-DST audit contribution.
    // Exclude only this exact known diagnostic outside the declared source scope; unknown or
    // mixed failures still block, as do every scoped and row-level physical failure.
    const missing =
      /^calibration_(QB|RB|WR|TE|K|DST)_(one-to-four|five-to-eight|nine-plus)_convergence_below_minimum$/u.exec(
        reason,
      );
    return !missing || positions.includes(missing[1] as FirstPartyRosPosition);
  });
}

/** Development evidence deliberately has no root publicationPolicy/champion/report admission shape. */
export function buildRosMarginalDevelopmentReport(input: PinnedRosMarginalDevelopmentInput) {
  const {
    candidate,
    previous,
    training,
    composite,
    intervalTraining,
    positions,
    originalPrevious,
    previousCounterfactual,
    frozenPrevious,
    derivedEvaluation,
  } = parsePinnedRosMarginalDevelopmentInputs(input);
  const marginal = evaluateFirstPartyRosMarginalPolicy(candidate.heldOutSeasons, {
    forecastSeason: input.forecastSeason,
    championOptions: candidate.options,
    ...(intervalTraining === null
      ? {}
      : { intervalTrainingSeasons: intervalTraining.heldOutSeasons }),
  });
  equal(marginal.legacyEvaluation, candidate.legacy, "marginal evaluator changed the mean policy");
  const cells = positions.flatMap((position) => BUCKETS.map((bucket) => ({ position, bucket })));
  const candidateSource = {
    ...candidate.source,
    policyVersion: FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
  };
  const isScoped = (row: { position: FirstPartyRosPosition; forecastSeason: number }) =>
    positions.includes(row.position) && row.forecastSeason === input.evaluationSeason;
  const toCandidateRow = (
    row: MarginalRosCandidateEvaluation,
    kind: "corrected" | "raw" | "legacy",
  ): MarginalIntervalComparisonRow => {
    if (kind === "corrected" && row.corrected === null)
      fail("required candidate interval is withheld");
    if (kind === "legacy" && row.legacyInterval.intervalCalibration !== "split-conformal-cqr")
      fail("required same-physics legacy comparator is uncalibrated");
    return {
      playerId: row.playerId,
      forecastSeason: row.forecastSeason,
      asOfWeek: row.asOfWeek,
      position: row.position,
      windowStartWeek: row.windowStartWeek,
      windowEndWeek: row.windowEndWeek,
      scheduledGames: row.scheduledGames,
      actualPoints: row.actualPoints,
      ...(kind === "corrected"
        ? row.corrected!
        : kind === "raw"
          ? row.rawQuantiles
          : row.legacyInterval),
    };
  };
  const previousRow = (
    forecast: FirstPartyRosHeldOutForecast,
    strategy: FirstPartyRosStrategy,
    raw: boolean,
  ): MarginalIntervalComparisonRow => {
    const frozen = previous.legacy.seasonPolicies.find(
      (audit) => audit.season === forecast.forecastSeason,
    )!.policy;
    const choice = frozen.choices.find(
      (choice) => choice.position === forecast.position && choice.bucket === bucket(forecast),
    )!;
    const key = candidateKey(strategy);
    const interval = applyFirstPartyRosIntervalCalibration(
      forecast[key],
      choice.intervalCalibrationArtifacts[key],
    );
    if (!raw && interval.intervalCalibration !== "split-conformal-cqr")
      fail("required previous-deployed comparator is uncalibrated");
    return {
      playerId:
        forecast.position === "DST" && forecast.playerId === "DST:LA"
          ? "DST:LAR"
          : forecast.playerId,
      forecastSeason: forecast.forecastSeason,
      asOfWeek: forecast.asOfWeek,
      position: forecast.position,
      windowStartWeek: forecast.windowStartWeek,
      windowEndWeek: forecast.windowEndWeek,
      scheduledGames: forecast.evidence.availability.scheduledGames,
      actualPoints: forecast.actualPoints,
      ...(raw ? forecast[key] : interval),
    };
  };
  const reasons: string[] = [];
  const cellComparisons = cells.map((cell) => {
    const choice = marginal.livePolicy.choices.find(
      (choice) => choice.position === cell.position && choice.bucket === cell.bucket,
    )!;
    const oldChoice = previous.legacy.livePolicy.choices.find(
      (choice) => choice.position === cell.position && choice.bucket === cell.bucket,
    )!;
    const key = candidateKey(choice.strategy),
      screen = choice.intervalScreens[key];
    if (screen?.state !== "descriptive-screen-passed")
      reasons.push(`${cell.position}:${cell.bucket}:marginal-screen:${screen?.state ?? "missing"}`);
    const rows = marginal.candidates.filter(
      (row) =>
        isScoped(row) &&
        row.position === cell.position &&
        row.bucket === cell.bucket &&
        row.strategy === choice.strategy,
    );
    const oldRows = previous.raw.filter(
      (row) => isScoped(row) && row.position === cell.position && bucket(row) === cell.bucket,
    );
    const evaluatedSeasons = candidate.seasons.slice(1);
    const evidence = choice.intervalEvidence[key];
    equal(
      evidence?.perSeason.map((row) => row.forecastSeason) ?? [],
      evaluatedSeasons,
      "missing declared prequential seasons",
    );
    if (
      marginal.candidates.some(
        (row) =>
          row.position === cell.position &&
          row.bucket === cell.bucket &&
          row.strategy === choice.strategy &&
          evaluatedSeasons.includes(row.forecastSeason) &&
          row.intervalState !== "corrected",
      )
    )
      fail("required prequential population is withheld");
    const comparison = compareMarginalIntervalCell({
      evaluationSeason: input.evaluationSeason,
      cell,
      candidate: {
        source: candidateSource,
        rows: rows.map((row) => toCandidateRow(row, "corrected")),
      },
      benchmarks: {
        "same-physics-legacy": {
          source: candidate.source,
          rows: rows.map((row) => toCandidateRow(row, "legacy")),
        },
        "previous-deployed": {
          source: previous.source,
          rows: oldRows.map((row) => previousRow(row, oldChoice.strategy, false)),
        },
      },
    });
    if (comparison.state !== "passed")
      reasons.push(
        ...comparison.worseThan.map(
          (name) => `${cell.position}:${cell.bucket}:wis-worse-than-${name}`,
        ),
      );
    return {
      position: cell.position,
      bucket: cell.bucket,
      strategy: choice.strategy,
      previousStrategy: oldChoice.strategy,
      intervalArtifact: choice.intervalArtifacts[key],
      evidence,
      screen,
      comparison,
    };
  });
  const selected = marginal.selected.filter(isScoped);
  const oldSelected = previous.raw.filter(isScoped).map((forecast) => {
    const choice = previous.legacy.seasonPolicies
      .find((audit) => audit.season === forecast.forecastSeason)!
      .policy.choices.find(
        (choice) => choice.position === forecast.position && choice.bucket === bucket(forecast),
      )!;
    return { forecast, strategy: choice.strategy };
  });
  const portfolio = compareMarginalIntervalPortfolio({
    evaluationSeason: input.evaluationSeason,
    cells,
    candidate: {
      source: candidateSource,
      rows: selected.map((row) => toCandidateRow(row, "corrected")),
    },
    benchmarks: {
      "same-physics-raw": {
        source: { ...candidate.source, policyVersion: "uncalibrated-raw-v1" },
        rows: selected.map((row) => toCandidateRow(row, "raw")),
      },
      "same-physics-legacy": {
        source: candidate.source,
        rows: selected.map((row) => toCandidateRow(row, "legacy")),
      },
      "previous-raw": {
        source: { ...previous.source, policyVersion: "uncalibrated-raw-v1" },
        rows: oldSelected.map(({ forecast, strategy }) => previousRow(forecast, strategy, true)),
      },
      "previous-deployed": {
        source: previous.source,
        rows: oldSelected.map(({ forecast, strategy }) => previousRow(forecast, strategy, false)),
      },
    },
  });
  reasons.push(...portfolio.worseThan.map((name) => `portfolio:wis-worse-than-${name}`));
  const preservedLegacyBlockers = candidate.blockers.filter((reason) => {
    const match = /^(?:cell|champion|calibration)_(QB|RB|WR|TE|K|DST)_/u.exec(reason);
    return !match || positions.includes(match[1] as FirstPartyRosPosition);
  });
  reasons.push(...preservedLegacyBlockers.map((reason) => `preserved-legacy:${reason}`));
  reasons.push(...candidate.physicalBlockers);
  if (training !== null) {
    // Broader-cohort mean/CQR gates stay diagnostic. Physical failures still block this experiment,
    // including failures absent from the original audit's independently sampled convergence check.
    reasons.push(...training.physicalBlockers.map((reason) => `interval-training:${reason}`));
    reasons.push(
      ...scopedRosTrainingConvergenceBlockers(training.blockers, training.positions).map(
        (reason) => `interval-training:preserved-legacy:${reason}`,
      ),
    );
  }
  const payload = {
    schemaVersion: composite !== null ? 4 : training === null ? 1 : 2,
    version:
      composite !== null
        ? ROS_MARGINAL_COMPOSITE_TRAINING_VERSION
        : training === null
          ? ROS_MARGINAL_DEVELOPMENT_VERSION
          : ROS_MARGINAL_TRAINING_DEVELOPMENT_VERSION,
    validationMode: "marginal-interval-development-only",
    state: reasons.length ? "rejected-at-development-screen" : "development-screen-passed",
    canAuthorizeRelease: false,
    noDatabaseWrites: true,
    forecastSeason: input.forecastSeason,
    evaluationSeason: input.evaluationSeason,
    positions,
    completePortfolio: positions.length === 6,
    identityAmendments: { previousPlayerId: { "DST:LA": "DST:LAR" } },
    provenance: {
      candidate: candidate.source,
      previous: previous.source,
      sources: candidate.sources,
      sourceComponentEquivalence: "requires-separate-pinned-source-preflight",
      ...(derivedEvaluation === null ? {} : { derivedEvaluation: derivedEvaluation.lineage }),
      ...(intervalTraining === null ? {} : { intervalTraining: intervalTraining.source }),
      ...(composite === null ? {} : { intervalTrainingComposition: composite.manifest }),
    },
    legacyEvaluation: {
      candidatePolicy: candidate.root.publicationPolicy,
      previousPolicy: originalPrevious?.root.publicationPolicy ?? previous.root.publicationPolicy,
      preservedLegacyBlockers,
      candidateReport: candidate.report,
      previousReport: originalPrevious?.report ?? previous.report,
      ...(previousCounterfactual === null
        ? {}
        : {
            refittedPreviousCounterfactual: {
              interpretation: "diagnostic-only-not-previous-deployed",
              policy: previousCounterfactual.legacy.livePolicy,
              report: previousCounterfactual.report,
            },
          }),
      physicalBlockers: candidate.physicalBlockers,
      ...(training === null
        ? {}
        : {
            intervalTraining: {
              interpretation: "diagnostic-only",
              fullReport: training.root,
              physicalBlockers: training.physicalBlockers,
            },
          }),
    },
    marginalDevelopment: { evaluation: marginal, cells: cellComparisons, portfolio, reasons },
  } as const;
  const development = {
    ...payload,
    evidenceChecksum: createHash("sha256").update(canonical(payload)).digest("hex"),
  };
  if (input.qualificationProtocolChecksum === undefined) return development;

  // Bind the exact standalone CLI serialization before adding qualification, avoiding a cyclic
  // checksum. The legacy report remains independently reconstructible from the same pinned inputs.
  const developmentReportChecksum = createHash("sha256")
    .update(`${JSON.stringify(development, null, 2)}\n`)
    .digest("hex");
  const sourceManifestChecksum = createHash("sha256")
    .update(canonical(candidate.sources))
    .digest("hex");
  const qualificationDataset = (source: {
    readonly source: MarginalIntervalComparisonSource;
    readonly heldOutSeasons: readonly FirstPartyRosHeldOutSeason[];
  }) => ({
    source: source.source,
    sourceManifestChecksum,
    heldOutSeasons: source.heldOutSeasons,
    rowsChecksum: validateMarginalRosTrainingCohort(source.heldOutSeasons, source.heldOutSeasons)
      .provenance.evaluationRowsChecksum,
  });
  const qualifications = buildRosMarginalIntervalQualificationSet({
    forecastSeason: input.forecastSeason,
    scope: {
      sourceSeasons: candidate.seasons,
      requiredCells: cells,
      protocolChecksum: input.qualificationProtocolChecksum,
      sourceManifestChecksum,
      fullReportChecksum: developmentReportChecksum,
      identityAmendment: "previous-defense-la-to-lar-v1",
    },
    candidate: qualificationDataset(candidate),
    previous: qualificationDataset(previous),
    ...(frozenPrevious === null ? {} : { frozenPrevious }),
    ...(intervalTraining === null
      ? {}
      : { intervalTraining: qualificationDataset(intervalTraining) }),
  });
  // The new shared admission boundary must reproduce every existing cell result exactly. It
  // cannot silently replace the report's cohort, final-live strategy, artifacts or comparisons.
  for (const qualification of qualifications) {
    const prior = cellComparisons.find(
      (cell) =>
        cell.position === qualification.cell.position && cell.bucket === qualification.cell.bucket,
    )!;
    equal(qualification.evidence, prior.evidence, "qualification changed interval evidence");
    equal(qualification.comparison, prior.comparison, "qualification changed WIS comparison");
    equal(
      qualification.liveArtifact,
      prior.intervalArtifact,
      "qualification changed live artifact",
    );
    if (
      qualification.strategy !== prior.strategy ||
      qualification.previousStrategy !== prior.previousStrategy ||
      (qualification.state === "qualified") !==
        (prior.screen?.state === "descriptive-screen-passed" && prior.comparison.state === "passed")
    )
      fail("qualification changed cell strategy or verdict");
  }
  const qualifiedPayload = {
    ...payload,
    schemaVersion: 3,
    version: ROS_MARGINAL_QUALIFIED_DEVELOPMENT_VERSION,
    qualification: {
      protocolChecksum: input.qualificationProtocolChecksum,
      developmentReportChecksum,
      developmentSchemaVersion: development.schemaVersion,
      developmentVersion: development.version,
      developmentEvidenceChecksum: development.evidenceChecksum,
      cells: qualifications,
    },
  } as const;
  return {
    ...qualifiedPayload,
    evidenceChecksum: createHash("sha256").update(canonical(qualifiedPayload)).digest("hex"),
  };
}
