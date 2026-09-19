import { NFL_TEAMS } from "@laces-out/domain";
import {
  LOCAL_ROS_INTERVAL_VERSION,
  fitLocalRosIntervalCalibration,
  prepareLocalRosIntervalCalibration,
  type LocalRosIntervalCalibrationFit,
  type LocalRosIntervalCorrection,
  type LocalRosIntervalHistoryRow,
} from "./local-ros-interval-calibration.js";
import {
  marginalIntervalArtifactSeriesKey,
  type MarginalIntervalArtifactContext,
} from "./marginal-interval-artifact.js";
import {
  validateMarginalRosTrainingCohort,
  type MarginalRosTrainingCohort,
} from "./marginal-ros-training.js";
import {
  applyFirstPartyRosIntervalCalibration,
  evaluateFirstPartyRosChampionPolicy,
  type FirstPartyRosCalibratedInterval,
  type FirstPartyRosChampionChoice,
  type FirstPartyRosChampionEvaluation,
  type FirstPartyRosChampionOptions,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutEvidence,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosHeldOutSeason,
  type FirstPartyRosPosition,
  type FirstPartyRosRemainingWeeksBucket,
  type FirstPartyRosStrategy,
} from "./rest-of-season.js";
import { sha256Hex } from "./sha256.js";

/** Isolated chronological application; neither this report nor its numerical fits admit a model. */
export const LOCAL_ROS_DEVELOPMENT_VERSION = "chronological-local-ros-development-v2";
const LEGACY_POLICY = "season-walk-forward-mean-rmse-block-wis-cqr-v7";
// Frozen v7 qualification settings. Future defaults cannot silently redefine this candidate.
const MEAN_OPTIONS = Object.freeze({
  minimumHeldOutSeasons: 3,
  minimumBatches: 30,
  minimumSamples: 300,
  minimumCellSeasons: 3,
  minimumCellSamples: 18,
  minimumCellCutoffs: 3,
  minimumCellBatches: 9,
  minimumModelImprovement: 0.01,
} as const satisfies Required<FirstPartyRosChampionOptions>);
const STRATEGIES = ["contextual", "availability-aware-recency"] as const;
type CandidateKey = "contextual" | "recency";

export interface LocalRosPhysicalIssue {
  readonly kind: "incomplete-input-coverage" | "unstable-physical-convergence";
  readonly identity: string;
  readonly inputChecksum: string;
  readonly coverage: number;
  readonly convergence: FirstPartyRosHeldOutEvidence["convergence"]["contextual"];
}
export type LocalRosScopeContext = Omit<MarginalIntervalArtifactContext, "bucket">;
export interface LocalRosScopeFit {
  readonly context: LocalRosScopeContext;
  readonly seriesKey: string;
  readonly selectedBucketsByMeanPolicy: readonly FirstPartyRosRemainingWeeksBucket[];
  readonly fit: LocalRosIntervalCalibrationFit;
  readonly training: {
    readonly priorForecasts: number;
    readonly includedForecasts: number;
    /** Existing v1 structural-zero exclusion, explicitly named and bound rather than hidden. */
    readonly zeroScheduledGameExclusions: readonly {
      readonly reason: "structural-zero-scheduled-games";
      readonly identity: string;
      readonly inputChecksum: string;
      readonly forecastSeason: number;
    }[];
    /** Successful regression cannot clear these independent physical-input failures. */
    readonly physicalIssues: readonly LocalRosPhysicalIssue[];
  };
}
export interface LocalRosSeasonFits {
  readonly forecastSeason: number;
  readonly completedSeasons: readonly number[];
  readonly scopes: readonly LocalRosScopeFit[];
}
export interface LocalRosCandidateEvaluation {
  readonly identity: string;
  readonly seriesKey: string;
  readonly playerId: string;
  readonly forecastSeason: number;
  readonly asOfWeek: number;
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly trainedThroughSeason: number;
  readonly inputChecksum: string;
  readonly scheduledGames: number;
  readonly actualPoints: number;
  readonly strategy: FirstPartyRosStrategy;
  readonly predictedMean: number;
  readonly rawQuantiles: {
    readonly p15Points: number;
    readonly p50Points: number;
    readonly p85Points: number;
  };
  readonly physicalEvidence: FirstPartyRosHeldOutEvidence;
  readonly physicalIssues: readonly LocalRosPhysicalIssue[];
  readonly fitChecksum: string;
  readonly intervalState: "corrected" | "withheld";
  readonly failure: {
    readonly code: "zero-scheduled-games" | "prior-fit-unavailable" | "application-unavailable";
    readonly reasons: readonly string[];
  } | null;
  /** Contains sorted endpoints plus every unsorted endpoint, feature and rearrangement detail. */
  readonly correction: LocalRosIntervalCorrection | null;
  readonly referenceProductionRank: number | null;
  readonly applicationSupport: LocalRosIntervalCorrection["support"] | null;
  /** Untouched same-physics v7 comparator, including its explicit not-calibrated state. */
  readonly legacyInterval: FirstPartyRosCalibratedInterval;
}
export interface LocalRosDevelopmentEvaluation {
  readonly version: typeof LOCAL_ROS_DEVELOPMENT_VERSION;
  readonly calibrationVersion: typeof LOCAL_ROS_INTERVAL_VERSION;
  readonly canAuthorizeRelease: false;
  /** Both checksums include original physical evidence; extra training never becomes audit data. */
  readonly cohort: MarginalRosTrainingCohort;
  readonly defenseRanks: LocalRosDefenseRanks;
  readonly seasonFits: readonly LocalRosSeasonFits[];
  readonly liveFits: LocalRosSeasonFits;
  readonly candidates: readonly LocalRosCandidateEvaluation[];
  readonly selected: readonly LocalRosCandidateEvaluation[];
  readonly auditCoverage: {
    readonly forecastIdentities: readonly string[];
    readonly forecasts: number;
    readonly candidateRows: number;
    readonly selectedRows: number;
    readonly correctedCandidateRows: number;
    readonly withheldCandidateRows: number;
    readonly physicallyFlaggedCandidateRows: number;
  };
  readonly meanSelectorOptions: typeof MEAN_OPTIONS;
  /** Exact locked selector, mean evidence and chronological legacy intervals. */
  readonly legacyEvaluation: FirstPartyRosChampionEvaluation;
}

export const LOCAL_ROS_DEFENSE_RANK_VERSION =
  "fixed-reference-last-four-played-dst-full32-ordinal-v1";
export interface LocalRosDefenseRankRow {
  readonly season: number;
  readonly asOfWeek: number;
  readonly canonicalTeam: string;
  readonly ordinalRank: number;
  readonly orderedUniverseChecksum: string;
}
export interface LocalRosDefenseRanks {
  readonly featureVersion: typeof LOCAL_ROS_DEFENSE_RANK_VERSION;
  /** Integrity of this compact rank input; external report/source provenance belongs to the worker. */
  readonly checksum: string;
  readonly rows: readonly LocalRosDefenseRankRow[];
}
export function localRosDefenseRanksChecksum(rows: readonly LocalRosDefenseRankRow[]): string {
  return sha256Hex(
    JSON.stringify({
      featureVersion: LOCAL_ROS_DEFENSE_RANK_VERSION,
      rows: rows.map((row) => ({
        season: row.season,
        asOfWeek: row.asOfWeek,
        canonicalTeam: row.canonicalTeam,
        ordinalRank: row.ordinalRank,
        orderedUniverseChecksum: row.orderedUniverseChecksum,
      })),
    }),
  );
}
function rankKey(season: number, asOfWeek: number, team: string): string {
  return JSON.stringify([season, asOfWeek, team]);
}
function rankArray(value: unknown): boolean {
  return Array.isArray(value) && Object.keys(value).length === value.length;
}
function checkedRanks(
  input: LocalRosDefenseRanks,
  training: readonly FirstPartyRosHeldOutSeason[],
) {
  if (
    input.featureVersion !== LOCAL_ROS_DEFENSE_RANK_VERSION ||
    !rankArray(input.rows) ||
    input.rows.length > 20_000 ||
    localRosDefenseRanksChecksum(input.rows) !== input.checksum
  )
    throw new Error("Local ROS defense rank integrity mismatch");
  const map = new Map<string, LocalRosDefenseRankRow>();
  const blocks = new Map<string, LocalRosDefenseRankRow[]>();
  for (const row of input.rows) {
    if (
      !Number.isSafeInteger(row.season) ||
      row.season < 2000 ||
      row.season > 2200 ||
      !Number.isSafeInteger(row.asOfWeek) ||
      row.asOfWeek < 1 ||
      row.asOfWeek > 17 ||
      !Number.isSafeInteger(row.ordinalRank) ||
      row.ordinalRank < 1 ||
      row.ordinalRank > 32 ||
      !NFL_TEAMS.some((team) => team === row.canonicalTeam)
    )
      throw new Error("Local ROS defense rank metadata invalid");
    const key = rankKey(row.season, row.asOfWeek, row.canonicalTeam);
    if (map.has(key)) throw new Error("Local ROS duplicate defense rank");
    map.set(key, row);
    const block = `${row.season}:${row.asOfWeek}`;
    blocks.set(block, [...(blocks.get(block) ?? []), row]);
  }
  for (const rows of blocks.values()) {
    const ordered = [...rows].sort((a, b) => a.ordinalRank - b.ordinalRank);
    if (
      ordered.length !== 32 ||
      ordered.some((row, index) => row.ordinalRank !== index + 1) ||
      ordered.some(
        (row) =>
          row.orderedUniverseChecksum !==
          sha256Hex(JSON.stringify(ordered.map((r) => r.canonicalTeam))),
      )
    )
      throw new Error("Local ROS defense rank universe incomplete");
  }
  const requiredBlocks = new Set<string>();
  for (const row of training.flatMap((season) => season.forecasts)) {
    if (row.position !== "DST") continue;
    if (
      !row.playerId.startsWith("DST:") ||
      !map.has(rankKey(row.forecastSeason, row.asOfWeek, row.playerId.slice(4)))
    )
      throw new Error("Local ROS missing canonical defense rank join");
    requiredBlocks.add(`${row.forecastSeason}:${row.asOfWeek}`);
  }
  if (
    requiredBlocks.size !== blocks.size ||
    [...blocks.keys()].some((key) => !requiredBlocks.has(key))
  )
    throw new Error("Local ROS defense rank scope mismatch");
  return map;
}

function key(strategy: FirstPartyRosStrategy): CandidateKey {
  return strategy === "contextual" ? "contextual" : "recency";
}
function bucket(forecast: FirstPartyRosHeldOutForecast): FirstPartyRosRemainingWeeksBucket {
  const weeks = forecast.windowEndWeek - forecast.windowStartWeek + 1;
  return weeks <= 4 ? "one-to-four" : weeks <= 8 ? "five-to-eight" : "nine-plus";
}
function identity(forecast: FirstPartyRosHeldOutForecast): string {
  return JSON.stringify([
    forecast.playerId,
    forecast.forecastSeason,
    forecast.asOfWeek,
    forecast.windowStartWeek,
    forecast.windowEndWeek,
    forecast.inputChecksum,
  ]);
}
function cellKey(position: FirstPartyRosPosition, horizon: FirstPartyRosRemainingWeeksBucket) {
  return `${position}:${horizon}`;
}
function fitKey(context: LocalRosScopeContext): string {
  return `${context.position}:${context.strategy}`;
}
function seriesKey(context: LocalRosScopeContext): string {
  // Reuse exact model/profile validation only; the new identity contains no horizon bucket.
  marginalIntervalArtifactSeriesKey({ ...context, bucket: "one-to-four" });
  return `ros-local:${sha256Hex(
    JSON.stringify([LOCAL_ROS_INTERVAL_VERSION, LOCAL_ROS_DEFENSE_RANK_VERSION, context]),
  )}`;
}
function historyRow(
  forecast: FirstPartyRosHeldOutForecast,
  strategy: FirstPartyRosStrategy,
  series: string,
  ranks: ReadonlyMap<string, LocalRosDefenseRankRow>,
): LocalRosIntervalHistoryRow {
  return {
    seriesKey: series,
    identity: identity(forecast),
    playerId: forecast.playerId,
    forecastSeason: forecast.forecastSeason,
    asOfWeek: forecast.asOfWeek,
    windowStartWeek: forecast.windowStartWeek,
    windowEndWeek: forecast.windowEndWeek,
    scheduledGames: forecast.evidence.availability.scheduledGames,
    actualPoints: forecast.actualPoints,
    referenceProductionRank:
      forecast.position === "DST"
        ? ranks.get(
            rankKey(forecast.forecastSeason, forecast.asOfWeek, forecast.playerId.slice(4)),
          )!.ordinalRank
        : null,
    ...forecast[key(strategy)],
  };
}
function physicalIssues(
  forecast: FirstPartyRosHeldOutForecast,
  strategy: FirstPartyRosStrategy,
): LocalRosPhysicalIssue[] {
  const candidate = key(strategy);
  const base = {
    identity: identity(forecast),
    inputChecksum: forecast.inputChecksum,
    coverage: forecast.evidence.coverage[candidate],
    convergence: { ...forecast.evidence.convergence[candidate] },
  };
  return [
    ...(base.coverage < 1 ? [{ ...base, kind: "incomplete-input-coverage" as const }] : []),
    ...(base.convergence.state !== "converged"
      ? [{ ...base, kind: "unstable-physical-convergence" as const }]
      : []),
  ];
}

function fitPrior(input: {
  readonly forecastSeason: number;
  readonly completedSeasons: readonly number[];
  readonly prior: readonly FirstPartyRosHeldOutForecast[];
  readonly meanPolicy: FirstPartyRosChampionPolicy;
  readonly ranks: ReadonlyMap<string, LocalRosDefenseRankRow>;
}): LocalRosSeasonFits {
  const evidenceIdentity = input.meanPolicy.evidenceIdentity;
  if (evidenceIdentity === null) throw new Error("Local ROS requires an evidence identity");
  const positions = [...new Set(input.meanPolicy.choices.map((choice) => choice.position))];
  const scopes = positions.flatMap((position) =>
    STRATEGIES.map((strategy): LocalRosScopeFit => {
      const context = { position, strategy, evidenceIdentity: { ...evidenceIdentity } };
      const series = seriesKey(context);
      const prior = input.prior.filter((row) => row.position === position);
      for (const row of prior) {
        const games = row.evidence.availability.scheduledGames;
        if (
          !Number.isSafeInteger(games) ||
          games < 0 ||
          games > Math.min(17, row.windowEndWeek - row.windowStartWeek + 1)
        )
          throw new Error("Local ROS prior exposure is invalid; no training row may be dropped");
      }
      const included = prior.filter((row) => row.evidence.availability.scheduledGames > 0);
      const excluded = prior.filter((row) => row.evidence.availability.scheduledGames === 0);
      if (included.length + excluded.length !== prior.length)
        throw new Error("Local ROS prior exposure partition is incomplete");
      return {
        context,
        seriesKey: series,
        selectedBucketsByMeanPolicy: input.meanPolicy.choices
          .filter((choice) => choice.position === position && choice.strategy === strategy)
          .map((choice) => choice.bucket),
        fit: fitLocalRosIntervalCalibration({
          seriesKey: series,
          position,
          forecastSeason: input.forecastSeason,
          completedSeasons: input.completedSeasons,
          rows: included.map((row) => historyRow(row, strategy, series, input.ranks)),
        }),
        training: {
          priorForecasts: prior.length,
          includedForecasts: included.length,
          zeroScheduledGameExclusions: excluded.map((row) => ({
            reason: "structural-zero-scheduled-games" as const,
            identity: identity(row),
            inputChecksum: row.inputChecksum,
            forecastSeason: row.forecastSeason,
          })),
          physicalIssues: prior.flatMap((row) => physicalIssues(row, strategy)),
        },
      };
    }),
  );
  return {
    forecastSeason: input.forecastSeason,
    completedSeasons: [...input.completedSeasons],
    scopes,
  };
}

function candidate(
  forecast: FirstPartyRosHeldOutForecast,
  cell: LocalRosScopeFit,
  meanChoice: FirstPartyRosChampionChoice,
  apply: ReturnType<typeof prepareLocalRosIntervalCalibration> | null,
  ranks: ReadonlyMap<string, LocalRosDefenseRankRow>,
): LocalRosCandidateEvaluation {
  const strategy = cell.context.strategy;
  const raw = historyRow(forecast, strategy, cell.seriesKey, ranks);
  const rawQuantiles = {
    p15Points: raw.p15Points,
    p50Points: raw.p50Points,
    p85Points: raw.p85Points,
  };
  const legacyArtifact = meanChoice.intervalCalibrationArtifacts[key(strategy)];
  const legacyInterval = applyFirstPartyRosIntervalCalibration(rawQuantiles, legacyArtifact);
  if (
    legacyInterval.intervalCalibration === "split-conformal-cqr" &&
    (legacyArtifact.trainedThroughSeason === null ||
      legacyArtifact.trainedThroughSeason >= forecast.forecastSeason)
  )
    throw new Error("Local ROS comparator must precede the forecast season");
  let failure: LocalRosCandidateEvaluation["failure"] = null;
  let correction: LocalRosIntervalCorrection | null = null;
  let applicationSupport: LocalRosIntervalCorrection["support"] | null = null;
  if (raw.scheduledGames === 0)
    failure = { code: "zero-scheduled-games", reasons: ["structural-zero-scheduled-games"] };
  else if (cell.fit.state === "unavailable")
    failure = { code: "prior-fit-unavailable", reasons: [...cell.fit.reasons] };
  else {
    if (apply === null) throw new Error("Local ROS fitted cell has no prepared application");
    try {
      const applied = apply(raw);
      if (applied.state === "corrected") {
        correction = applied.correction;
        applicationSupport = correction.support;
      } else {
        applicationSupport = applied.support;
        failure = { code: "application-unavailable", reasons: [...applied.reasons] };
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failure = { code: "application-unavailable", reasons: [error.message] };
    }
  }
  return {
    identity: raw.identity,
    seriesKey: cell.seriesKey,
    playerId: forecast.playerId,
    forecastSeason: forecast.forecastSeason,
    asOfWeek: forecast.asOfWeek,
    position: forecast.position,
    bucket: bucket(forecast),
    windowStartWeek: forecast.windowStartWeek,
    windowEndWeek: forecast.windowEndWeek,
    trainedThroughSeason: forecast.trainedThroughSeason,
    inputChecksum: forecast.inputChecksum,
    scheduledGames: raw.scheduledGames,
    actualPoints: forecast.actualPoints,
    strategy,
    predictedMean: raw.meanPoints,
    rawQuantiles,
    physicalEvidence: structuredClone(forecast.evidence),
    physicalIssues: physicalIssues(forecast, strategy),
    fitChecksum: cell.fit.checksum,
    intervalState: correction === null ? "withheld" : "corrected",
    failure,
    correction,
    referenceProductionRank: raw.referenceProductionRank,
    applicationSupport,
    legacyInterval,
  };
}

/**
 * Evaluate exactly the original audit, both strategies, before appending each whole training
 * season. Extra rows affect interval fits alone. Physical diagnostics are retained even when an
 * interval can be computed; numerical optimality or successful application cannot clear them.
 * This adapter has no configurable math, selector thresholds, admission or publication path.
 */
export function evaluateLocalRosDevelopment(
  heldOutSeasons: readonly FirstPartyRosHeldOutSeason[],
  options: {
    readonly forecastSeason: number;
    readonly intervalTrainingSeasons?: readonly FirstPartyRosHeldOutSeason[];
    readonly defenseRanks: LocalRosDefenseRanks;
  },
): LocalRosDevelopmentEvaluation {
  if (
    !Number.isSafeInteger(options.forecastSeason) ||
    options.forecastSeason < 2000 ||
    options.forecastSeason > 2200 ||
    heldOutSeasons.some((season) => season.season >= options.forecastSeason)
  )
    throw new RangeError("Local ROS live season must follow every audit season");
  const training = validateMarginalRosTrainingCohort(
    heldOutSeasons,
    options.intervalTrainingSeasons ?? heldOutSeasons,
  );
  const ranks = checkedRanks(options.defenseRanks, training.ordered);
  const ordered = [...heldOutSeasons].sort((left, right) => left.season - right.season);
  const legacyEvaluation = evaluateFirstPartyRosChampionPolicy(ordered, MEAN_OPTIONS);
  for (const policy of [
    legacyEvaluation.livePolicy,
    ...legacyEvaluation.seasonPolicies.map((year) => year.policy),
  ]) {
    if (
      policy.policyVersion !== LEGACY_POLICY ||
      (Object.keys(MEAN_OPTIONS) as (keyof typeof MEAN_OPTIONS)[]).some(
        (field) => policy[field] !== MEAN_OPTIONS[field],
      )
    )
      throw new Error("Local ROS requires the unchanged v7 mean comparator and locked options");
  }
  const prior: FirstPartyRosHeldOutForecast[] = [];
  const completedSeasons: number[] = [];
  const seasonFits: LocalRosSeasonFits[] = [];
  const candidates: LocalRosCandidateEvaluation[] = [];
  const selected: LocalRosCandidateEvaluation[] = [];
  const forecastIdentities: string[] = [];
  for (const [index, season] of ordered.entries()) {
    const meanPolicy = legacyEvaluation.seasonPolicies[index]!.policy;
    const fits = fitPrior({
      forecastSeason: season.season,
      completedSeasons,
      prior,
      meanPolicy,
      ranks,
    });
    seasonFits.push(fits);
    const byCell = new Map(fits.scopes.map((cell) => [fitKey(cell.context), cell]));
    const prepared = new Map(
      fits.scopes.map((cell) => [
        fitKey(cell.context),
        cell.fit.state === "fitted" ? prepareLocalRosIntervalCalibration(cell.fit) : null,
      ]),
    );
    const meanChoices = new Map(
      meanPolicy.choices.map((choice) => [cellKey(choice.position, choice.bucket), choice]),
    );
    for (const forecast of season.forecasts) {
      forecastIdentities.push(identity(forecast));
      const choice = meanChoices.get(cellKey(forecast.position, bucket(forecast)))!;
      for (const strategy of STRATEGIES) {
        const cell = byCell.get(`${forecast.position}:${strategy}`)!;
        const row = candidate(forecast, cell, choice, prepared.get(fitKey(cell.context))!, ranks);
        candidates.push(row);
        if (strategy === choice.strategy) selected.push(row);
      }
    }
    prior.push(...training.ordered[index]!.forecasts);
    completedSeasons.push(season.season);
  }
  if (
    forecastIdentities.length !== training.provenance.evaluationForecasts ||
    candidates.length !== forecastIdentities.length * 2 ||
    selected.length !== forecastIdentities.length
  )
    throw new Error("Local ROS audit coverage invariant failed");
  return {
    version: LOCAL_ROS_DEVELOPMENT_VERSION,
    calibrationVersion: LOCAL_ROS_INTERVAL_VERSION,
    canAuthorizeRelease: false,
    meanSelectorOptions: { ...MEAN_OPTIONS },
    cohort: training.provenance,
    defenseRanks: structuredClone(options.defenseRanks),
    seasonFits,
    liveFits: fitPrior({
      forecastSeason: options.forecastSeason,
      completedSeasons,
      prior,
      meanPolicy: legacyEvaluation.livePolicy,
      ranks,
    }),
    candidates,
    selected,
    auditCoverage: {
      forecastIdentities,
      forecasts: forecastIdentities.length,
      candidateRows: candidates.length,
      selectedRows: selected.length,
      correctedCandidateRows: candidates.filter((row) => row.correction !== null).length,
      withheldCandidateRows: candidates.filter((row) => row.correction === null).length,
      physicallyFlaggedCandidateRows: candidates.filter((row) => row.physicalIssues.length > 0)
        .length,
    },
    legacyEvaluation,
  };
}
