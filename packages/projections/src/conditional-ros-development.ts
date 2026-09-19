import {
  CONDITIONAL_INTERVAL_CALIBRATION_VERSION,
  fitConditionalIntervalCalibration,
  prepareConditionalIntervalCalibration,
  type ConditionalIntervalCalibrationFit,
  type ConditionalIntervalCorrection,
  type ConditionalIntervalHistoryRow,
} from "./conditional-interval-calibration.js";
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
export const CONDITIONAL_ROS_DEVELOPMENT_VERSION = "chronological-conditional-ros-development-v1";
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

export interface ConditionalRosPhysicalIssue {
  readonly kind: "incomplete-input-coverage" | "unstable-physical-convergence";
  readonly identity: string;
  readonly inputChecksum: string;
  readonly coverage: number;
  readonly convergence: FirstPartyRosHeldOutEvidence["convergence"]["contextual"];
}
export interface ConditionalRosCellFit {
  readonly context: MarginalIntervalArtifactContext;
  readonly seriesKey: string;
  readonly selectedByMeanPolicy: boolean;
  readonly fit: ConditionalIntervalCalibrationFit;
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
    readonly physicalIssues: readonly ConditionalRosPhysicalIssue[];
  };
}
export interface ConditionalRosSeasonFits {
  readonly forecastSeason: number;
  readonly completedSeasons: readonly number[];
  readonly cells: readonly ConditionalRosCellFit[];
}
export interface ConditionalRosCandidateEvaluation {
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
  readonly physicalIssues: readonly ConditionalRosPhysicalIssue[];
  readonly fitChecksum: string;
  readonly intervalState: "corrected" | "withheld";
  readonly failure: {
    readonly code: "zero-scheduled-games" | "prior-fit-unavailable" | "application-unavailable";
    readonly reasons: readonly string[];
  } | null;
  /** Contains sorted endpoints plus every unsorted endpoint, feature and rearrangement detail. */
  readonly correction: ConditionalIntervalCorrection | null;
  /** Untouched same-physics v7 comparator, including its explicit not-calibrated state. */
  readonly legacyInterval: FirstPartyRosCalibratedInterval;
}
export interface ConditionalRosDevelopmentEvaluation {
  readonly version: typeof CONDITIONAL_ROS_DEVELOPMENT_VERSION;
  readonly calibrationVersion: typeof CONDITIONAL_INTERVAL_CALIBRATION_VERSION;
  readonly canAuthorizeRelease: false;
  /** Both checksums include original physical evidence; extra training never becomes audit data. */
  readonly cohort: MarginalRosTrainingCohort;
  readonly seasonFits: readonly ConditionalRosSeasonFits[];
  readonly liveFits: ConditionalRosSeasonFits;
  readonly candidates: readonly ConditionalRosCandidateEvaluation[];
  readonly selected: readonly ConditionalRosCandidateEvaluation[];
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
function fitKey(context: MarginalIntervalArtifactContext): string {
  return `${cellKey(context.position, context.bucket)}:${context.strategy}`;
}
function seriesKey(context: MarginalIntervalArtifactContext): string {
  // Reuse exact whole-profile/model/cell validation, but give this method its own namespace.
  return `ros-conditional:${sha256Hex(
    JSON.stringify([
      CONDITIONAL_INTERVAL_CALIBRATION_VERSION,
      marginalIntervalArtifactSeriesKey(context),
    ]),
  )}`;
}
function historyRow(
  forecast: FirstPartyRosHeldOutForecast,
  strategy: FirstPartyRosStrategy,
  series: string,
): ConditionalIntervalHistoryRow {
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
    ...forecast[key(strategy)],
  };
}
function physicalIssues(
  forecast: FirstPartyRosHeldOutForecast,
  strategy: FirstPartyRosStrategy,
): ConditionalRosPhysicalIssue[] {
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
}): ConditionalRosSeasonFits {
  const evidenceIdentity = input.meanPolicy.evidenceIdentity;
  if (evidenceIdentity === null) throw new Error("Conditional ROS requires an evidence identity");
  const cells = input.meanPolicy.choices.flatMap((choice) =>
    STRATEGIES.map((strategy): ConditionalRosCellFit => {
      const context = {
        position: choice.position,
        bucket: choice.bucket,
        strategy,
        evidenceIdentity: { ...evidenceIdentity },
      };
      const series = seriesKey(context);
      const prior = input.prior.filter(
        (row) => row.position === choice.position && bucket(row) === choice.bucket,
      );
      const included = prior.filter((row) => row.evidence.availability.scheduledGames > 0);
      const zeroScheduledGameExclusions = prior
        .filter((row) => row.evidence.availability.scheduledGames === 0)
        .map((row) => ({
          reason: "structural-zero-scheduled-games" as const,
          identity: identity(row),
          inputChecksum: row.inputChecksum,
          forecastSeason: row.forecastSeason,
        }));
      return {
        context,
        seriesKey: series,
        selectedByMeanPolicy: choice.strategy === strategy,
        fit: fitConditionalIntervalCalibration({
          seriesKey: series,
          forecastSeason: input.forecastSeason,
          completedSeasons: input.completedSeasons,
          rows: included.map((row) => historyRow(row, strategy, series)),
        }),
        training: {
          priorForecasts: prior.length,
          includedForecasts: included.length,
          zeroScheduledGameExclusions,
          physicalIssues: prior.flatMap((row) => physicalIssues(row, strategy)),
        },
      };
    }),
  );
  return {
    forecastSeason: input.forecastSeason,
    completedSeasons: [...input.completedSeasons],
    cells,
  };
}

function candidate(
  forecast: FirstPartyRosHeldOutForecast,
  cell: ConditionalRosCellFit,
  meanChoice: FirstPartyRosChampionChoice,
  apply: ReturnType<typeof prepareConditionalIntervalCalibration> | null,
): ConditionalRosCandidateEvaluation {
  const strategy = cell.context.strategy;
  const raw = historyRow(forecast, strategy, cell.seriesKey);
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
    throw new Error("Conditional ROS comparator must precede the forecast season");
  let failure: ConditionalRosCandidateEvaluation["failure"] = null;
  let correction: ConditionalIntervalCorrection | null = null;
  if (raw.scheduledGames === 0)
    failure = { code: "zero-scheduled-games", reasons: ["structural-zero-scheduled-games"] };
  else if (cell.fit.state === "unavailable")
    failure = { code: "prior-fit-unavailable", reasons: [...cell.fit.reasons] };
  else {
    if (apply === null) throw new Error("Conditional ROS fitted cell has no prepared application");
    try {
      correction = apply(raw);
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
    bucket: cell.context.bucket,
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
    legacyInterval,
  };
}

/**
 * Evaluate exactly the original audit, both strategies, before appending each whole training
 * season. Extra rows affect interval fits alone. Physical diagnostics are retained even when an
 * interval can be computed; numerical optimality or successful application cannot clear them.
 * This adapter has no configurable math, selector thresholds, admission or publication path.
 */
export function evaluateConditionalRosDevelopment(
  heldOutSeasons: readonly FirstPartyRosHeldOutSeason[],
  options: {
    readonly forecastSeason: number;
    readonly intervalTrainingSeasons?: readonly FirstPartyRosHeldOutSeason[];
  },
): ConditionalRosDevelopmentEvaluation {
  if (
    !Number.isSafeInteger(options.forecastSeason) ||
    options.forecastSeason < 2000 ||
    options.forecastSeason > 2200 ||
    heldOutSeasons.some((season) => season.season >= options.forecastSeason)
  )
    throw new RangeError("Conditional ROS live season must follow every audit season");
  const training = validateMarginalRosTrainingCohort(
    heldOutSeasons,
    options.intervalTrainingSeasons ?? heldOutSeasons,
  );
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
      throw new Error(
        "Conditional ROS requires the unchanged v7 mean comparator and locked options",
      );
  }
  const prior: FirstPartyRosHeldOutForecast[] = [];
  const completedSeasons: number[] = [];
  const seasonFits: ConditionalRosSeasonFits[] = [];
  const candidates: ConditionalRosCandidateEvaluation[] = [];
  const selected: ConditionalRosCandidateEvaluation[] = [];
  const forecastIdentities: string[] = [];
  for (const [index, season] of ordered.entries()) {
    const meanPolicy = legacyEvaluation.seasonPolicies[index]!.policy;
    const fits = fitPrior({ forecastSeason: season.season, completedSeasons, prior, meanPolicy });
    seasonFits.push(fits);
    const byCell = new Map(fits.cells.map((cell) => [fitKey(cell.context), cell]));
    const prepared = new Map(
      fits.cells.map((cell) => [
        fitKey(cell.context),
        cell.fit.state === "fitted" ? prepareConditionalIntervalCalibration(cell.fit) : null,
      ]),
    );
    const meanChoices = new Map(
      meanPolicy.choices.map((choice) => [cellKey(choice.position, choice.bucket), choice]),
    );
    for (const forecast of season.forecasts) {
      forecastIdentities.push(identity(forecast));
      const choice = meanChoices.get(cellKey(forecast.position, bucket(forecast)))!;
      for (const strategy of STRATEGIES) {
        const cell = byCell.get(`${cellKey(forecast.position, bucket(forecast))}:${strategy}`)!;
        const row = candidate(forecast, cell, choice, prepared.get(fitKey(cell.context))!);
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
    throw new Error("Conditional ROS audit coverage invariant failed");
  return {
    version: CONDITIONAL_ROS_DEVELOPMENT_VERSION,
    calibrationVersion: CONDITIONAL_INTERVAL_CALIBRATION_VERSION,
    canAuthorizeRelease: false,
    meanSelectorOptions: { ...MEAN_OPTIONS },
    cohort: training.provenance,
    seasonFits,
    liveFits: fitPrior({
      forecastSeason: options.forecastSeason,
      completedSeasons,
      prior,
      meanPolicy: legacyEvaluation.livePolicy,
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
