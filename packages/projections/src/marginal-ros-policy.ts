import {
  applyMarginalIntervalArtifact,
  createMarginalIntervalArtifact,
  marginalIntervalArtifactSeriesKey,
  type MarginalIntervalArtifact,
  type MarginalIntervalArtifactContext,
} from "./marginal-interval-artifact.js";
import {
  MARGINAL_INTERVAL_CALIBRATION_VERSION,
  type MarginalIntervalCorrection,
  type MarginalIntervalHistoryRow,
  type MarginalIntervalQuantiles,
} from "./marginal-interval-calibration.js";
import {
  buildMarginalIntervalEvidence,
  evaluateMarginalIntervalEvidence,
  type MarginalIntervalEvaluationRow,
  type MarginalIntervalEvidence,
  type MarginalIntervalScreenResult,
} from "./marginal-interval-evidence.js";
import {
  applyFirstPartyRosIntervalCalibration,
  evaluateFirstPartyRosChampionPolicy,
  type FirstPartyRosCalibratedInterval,
  type FirstPartyRosChampionChoice,
  type FirstPartyRosChampionEvaluation,
  type FirstPartyRosChampionOptions,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosEvidenceIdentity,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosHeldOutSeason,
  type FirstPartyRosPosition,
  type FirstPartyRosRemainingWeeksBucket,
  type FirstPartyRosStrategy,
} from "./rest-of-season.js";
import { sha256Hex } from "./sha256.js";
import {
  validateMarginalRosTrainingCohort,
  type MarginalRosTrainingCohort,
} from "./marginal-ros-training.js";

/** Candidate evaluation only. Neither a fitted correction nor a descriptive screen admits it. */
export const FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION =
  "season-walk-forward-mean-rmse-marginal-quantiles-v8";
const LEGACY_POLICY_VERSION = "season-walk-forward-mean-rmse-block-wis-cqr-v7";
const STRATEGIES = ["contextual", "availability-aware-recency"] as const;
type CandidateKey = "contextual" | "recency";
type Candidates<T> = Readonly<Record<CandidateKey, T>>;

export interface MarginalRosCandidateEvaluation {
  readonly identity: string;
  readonly seriesKey: string;
  readonly playerId: string;
  readonly forecastSeason: number;
  readonly asOfWeek: number;
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly scheduledGames: number;
  readonly inputChecksum: string;
  readonly actualPoints: number;
  readonly strategy: FirstPartyRosStrategy;
  /** Copied exactly from the physical candidate. Interval correction never changes this mean. */
  readonly predictedMean: number;
  readonly rawQuantiles: MarginalIntervalQuantiles;
  readonly intervalState: "corrected" | "withheld";
  readonly withheldReason: "zero-scheduled-games" | "insufficient-prior-fit" | null;
  /** Present even when the locked artifact explicitly has insufficient support. */
  readonly calibrationArtifactChecksum: string;
  /** Null is deliberate: an unsupported interval must not masquerade as a calibrated raw range. */
  readonly corrected: MarginalIntervalEvaluationRow | null;
  readonly rearrangement: MarginalIntervalCorrection["rearrangement"] | null;
  /** Same-physics v7 comparator. Its explicit not-calibrated state is not a usable benchmark. */
  readonly legacyInterval: FirstPartyRosCalibratedInterval;
}

export interface MarginalRosEvaluationSupport {
  readonly forecasts: number;
  readonly corrected: number;
  readonly insufficientPriorFit: number;
  readonly zeroScheduledGames: number;
}

export interface MarginalRosChampionChoice {
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
  readonly strategy: FirstPartyRosStrategy;
  /** Original v7 selector and proof, including its raw-WIS safeguard; never reconstructed. */
  readonly meanChoice: FirstPartyRosChampionChoice;
  /** Missing identity yields null; known identity with too few rows yields an insufficient fit. */
  readonly intervalArtifacts: Candidates<MarginalIntervalArtifact | null>;
  readonly intervalEvidence: Candidates<MarginalIntervalEvidence | null>;
  readonly intervalScreens: Candidates<MarginalIntervalScreenResult | null>;
  readonly support: Candidates<MarginalRosEvaluationSupport>;
  /** Chronological selection can differ from the final-live strategy. */
  readonly selectedEvidence: MarginalIntervalEvidence | null;
  readonly selectedScreen: MarginalIntervalScreenResult | null;
  readonly selectedSupport: MarginalRosEvaluationSupport;
}

export interface MarginalRosChampionPolicy {
  readonly policyVersion: typeof FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION;
  readonly calibrationVersion: typeof MARGINAL_INTERVAL_CALIBRATION_VERSION;
  /** Explicit forecast season, including gaps; never inferred as evidenceThroughSeason + 1. */
  readonly forecastSeason: number;
  readonly evidenceThroughSeason: number | null;
  readonly evidenceIdentity: FirstPartyRosEvidenceIdentity | null;
  readonly meanPolicy: FirstPartyRosChampionPolicy;
  readonly choices: readonly MarginalRosChampionChoice[];
}

export interface MarginalRosChampionEvaluation {
  readonly policyVersion: typeof FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION;
  /** Present only for an explicitly supplied, separately bound interval-training cohort. */
  readonly intervalTraining?: MarginalRosTrainingCohort;
  readonly livePolicy: MarginalRosChampionPolicy;
  readonly seasonPolicies: readonly {
    readonly season: number;
    readonly policy: MarginalRosChampionPolicy;
  }[];
  /** Both strategies, including every withheld row, in chronological/input row order. */
  readonly candidates: readonly MarginalRosCandidateEvaluation[];
  /** Exactly the season-locked v7 mean strategy; no interval failure switches candidates. */
  readonly selected: readonly MarginalRosCandidateEvaluation[];
  /** Complete, untouched result used for the mean invariance proof and legacy comparisons. */
  readonly legacyEvaluation: FirstPartyRosChampionEvaluation;
}

function key(strategy: FirstPartyRosStrategy): CandidateKey {
  return strategy === "contextual" ? "contextual" : "recency";
}

function bucket(forecast: FirstPartyRosHeldOutForecast): FirstPartyRosRemainingWeeksBucket {
  const remaining = forecast.windowEndWeek - forecast.windowStartWeek + 1;
  return remaining <= 4 ? "one-to-four" : remaining <= 8 ? "five-to-eight" : "nine-plus";
}

function cellKey(position: FirstPartyRosPosition, window: FirstPartyRosRemainingWeeksBucket) {
  return `${position}:${window}`;
}

function quantiles(value: MarginalIntervalQuantiles): MarginalIntervalQuantiles {
  return { p15Points: value.p15Points, p50Points: value.p50Points, p85Points: value.p85Points };
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

function contextFor(
  meanPolicy: FirstPartyRosChampionPolicy,
  choice: FirstPartyRosChampionChoice,
  strategy: FirstPartyRosStrategy,
): MarginalIntervalArtifactContext | null {
  return meanPolicy.evidenceIdentity === null
    ? null
    : {
        position: choice.position,
        bucket: choice.bucket,
        strategy,
        evidenceIdentity: meanPolicy.evidenceIdentity,
      };
}

function historyRow(
  forecast: FirstPartyRosHeldOutForecast,
  strategy: FirstPartyRosStrategy,
  context: MarginalIntervalArtifactContext,
): MarginalIntervalHistoryRow {
  return {
    identity: identity(forecast),
    playerId: forecast.playerId,
    seriesKey: marginalIntervalArtifactSeriesKey(context),
    forecastSeason: forecast.forecastSeason,
    asOfWeek: forecast.asOfWeek,
    windowStartWeek: forecast.windowStartWeek,
    windowEndWeek: forecast.windowEndWeek,
    scheduledGames: forecast.evidence.availability.scheduledGames,
    actualPoints: forecast.actualPoints,
    ...quantiles(forecast[key(strategy)]),
  };
}

function support(rows: readonly MarginalRosCandidateEvaluation[]): MarginalRosEvaluationSupport {
  return {
    forecasts: rows.length,
    corrected: rows.filter((row) => row.intervalState === "corrected").length,
    insufficientPriorFit: rows.filter((row) => row.withheldReason === "insufficient-prior-fit")
      .length,
    zeroScheduledGames: rows.filter((row) => row.withheldReason === "zero-scheduled-games").length,
  };
}

function intervalEvidence(
  seriesKey: string,
  rows: readonly MarginalRosCandidateEvaluation[],
): MarginalIntervalEvidence {
  return buildMarginalIntervalEvidence({
    seriesKey,
    rows: rows.flatMap((row) => (row.corrected === null ? [] : [{ ...row.corrected, seriesKey }])),
  });
}

/** This key identifies the season-locked selected policy, rather than either fixed candidate. */
function selectedSeriesKey(context: MarginalIntervalArtifactContext): string {
  const scope = {
    position: context.position,
    bucket: context.bucket,
    evidenceIdentity: {
      contextualModelVersion: context.evidenceIdentity.contextualModelVersion,
      recencyModelVersion: context.evidenceIdentity.recencyModelVersion,
      scoringProfileKey: context.evidenceIdentity.scoringProfileKey,
      intervalMethodVersion: context.evidenceIdentity.intervalMethodVersion,
    },
  };
  return `ros-marginal-selected:${sha256Hex(JSON.stringify(scope))}`;
}

function policyFromPriorSeasons(input: {
  readonly forecastSeason: number;
  readonly completedSeasons: readonly number[];
  readonly history: ReadonlyMap<string, readonly MarginalIntervalHistoryRow[]>;
  readonly candidates: readonly MarginalRosCandidateEvaluation[];
  readonly selected: readonly MarginalRosCandidateEvaluation[];
  readonly meanPolicy: FirstPartyRosChampionPolicy;
}): MarginalRosChampionPolicy {
  const { meanPolicy } = input;
  const choices = meanPolicy.choices.map((meanChoice): MarginalRosChampionChoice => {
    const rows = input.candidates.filter(
      (row) => row.position === meanChoice.position && row.bucket === meanChoice.bucket,
    );
    const selected = input.selected.filter(
      (row) => row.position === meanChoice.position && row.bucket === meanChoice.bucket,
    );
    const build = (strategy: FirstPartyRosStrategy) => {
      const context = contextFor(meanPolicy, meanChoice, strategy);
      const candidateRows = rows.filter((row) => row.strategy === strategy);
      const seriesKey = context === null ? null : marginalIntervalArtifactSeriesKey(context);
      const artifact =
        context === null || seriesKey === null
          ? null
          : createMarginalIntervalArtifact({
              context,
              forecastSeason: input.forecastSeason,
              completedSeasons: input.completedSeasons,
              rows: input.history.get(seriesKey) ?? [],
            });
      const evidence = seriesKey === null ? null : intervalEvidence(seriesKey, candidateRows);
      return {
        artifact,
        evidence,
        screen: evidence === null ? null : evaluateMarginalIntervalEvidence(evidence),
        support: support(candidateRows),
      };
    };
    const contextual = build("contextual");
    const recency = build("availability-aware-recency");
    const context = contextFor(meanPolicy, meanChoice, meanChoice.strategy);
    const selectedEvidence =
      context === null ? null : intervalEvidence(selectedSeriesKey(context), selected);
    return {
      position: meanChoice.position,
      bucket: meanChoice.bucket,
      strategy: meanChoice.strategy,
      meanChoice,
      intervalArtifacts: { contextual: contextual.artifact, recency: recency.artifact },
      intervalEvidence: { contextual: contextual.evidence, recency: recency.evidence },
      intervalScreens: { contextual: contextual.screen, recency: recency.screen },
      support: { contextual: contextual.support, recency: recency.support },
      selectedEvidence,
      selectedScreen:
        selectedEvidence === null ? null : evaluateMarginalIntervalEvidence(selectedEvidence),
      selectedSupport: support(selected),
    };
  });
  return {
    policyVersion: FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
    calibrationVersion: MARGINAL_INTERVAL_CALIBRATION_VERSION,
    forecastSeason: input.forecastSeason,
    evidenceThroughSeason: meanPolicy.evidenceThroughSeason,
    evidenceIdentity: meanPolicy.evidenceIdentity,
    meanPolicy,
    choices,
  };
}

function evaluateCandidate(
  forecast: FirstPartyRosHeldOutForecast,
  choice: MarginalRosChampionChoice,
  strategy: FirstPartyRosStrategy,
): MarginalRosCandidateEvaluation {
  const candidateKey = key(strategy);
  const artifact = choice.intervalArtifacts[candidateKey];
  if (artifact === null) throw new Error("Marginal forecast has no evidence identity");
  const raw = historyRow(forecast, strategy, artifact.context);
  const rawQuantiles = quantiles(raw);
  const legacyArtifact = choice.meanChoice.intervalCalibrationArtifacts[candidateKey];
  const legacyInterval = applyFirstPartyRosIntervalCalibration(rawQuantiles, legacyArtifact);
  if (
    legacyInterval.intervalCalibration === "split-conformal-cqr" &&
    (legacyArtifact.trainedThroughSeason === null ||
      legacyArtifact.trainedThroughSeason >= forecast.forecastSeason)
  )
    throw new Error("Legacy comparator must be fitted strictly before the forecast season");
  const withheldReason =
    raw.scheduledGames === 0
      ? "zero-scheduled-games"
      : artifact.fit.state === "insufficient-evidence"
        ? "insufficient-prior-fit"
        : null;
  const correction =
    withheldReason === null ? applyMarginalIntervalArtifact(raw, artifact.context, artifact) : null;
  const corrected: MarginalIntervalEvaluationRow | null =
    correction === null
      ? null
      : {
          ...raw,
          ...quantiles(correction),
          rawQuantiles,
          artifactChecksum: artifact.artifactChecksum,
          trainedThroughSeason: Math.max(...artifact.fit.priorSeasons),
        };
  return {
    identity: raw.identity,
    seriesKey: raw.seriesKey,
    playerId: forecast.playerId,
    forecastSeason: forecast.forecastSeason,
    asOfWeek: forecast.asOfWeek,
    position: forecast.position,
    bucket: bucket(forecast),
    windowStartWeek: forecast.windowStartWeek,
    windowEndWeek: forecast.windowEndWeek,
    scheduledGames: raw.scheduledGames,
    inputChecksum: forecast.inputChecksum,
    actualPoints: forecast.actualPoints,
    strategy,
    predictedMean: forecast[candidateKey].meanPoints,
    rawQuantiles,
    intervalState: correction === null ? "withheld" : "corrected",
    withheldReason,
    calibrationArtifactChecksum: artifact.artifactChecksum,
    corrected,
    rearrangement: correction?.rearrangement ?? null,
    legacyInterval,
  };
}

/**
 * Freeze both interval fits before each complete season, then append that entire season's raw
 * outcomes. The v7 evaluator supplies every mean choice/proof unchanged, including the raw-WIS
 * safeguard. Interval support is independent of mean support. This evaluator neither admits a
 * model nor replaces any source, mean, availability, convergence, or proper-score release gate.
 */
export function evaluateFirstPartyRosMarginalPolicy(
  heldOutSeasons: readonly FirstPartyRosHeldOutSeason[],
  options: {
    readonly forecastSeason: number;
    readonly championOptions?: FirstPartyRosChampionOptions;
    /** Extra prior-fit rows never participate in the mean selector or held-out evaluation. */
    readonly intervalTrainingSeasons?: readonly FirstPartyRosHeldOutSeason[];
  },
): MarginalRosChampionEvaluation {
  if (
    !Number.isSafeInteger(options.forecastSeason) ||
    options.forecastSeason < 2000 ||
    options.forecastSeason > 2200 ||
    heldOutSeasons.some((season) => season.season >= options.forecastSeason)
  )
    throw new RangeError("Marginal live forecast season must follow every held-out season");
  // Do not independently reimplement, simplify, or reinterpret any v7 mean-selection rule.
  const legacyEvaluation = evaluateFirstPartyRosChampionPolicy(
    heldOutSeasons,
    options.championOptions,
  );
  if (legacyEvaluation.livePolicy.policyVersion !== LEGACY_POLICY_VERSION)
    throw new Error("Marginal evaluator requires the unchanged v7 mean-policy comparator");
  const ordered = [...heldOutSeasons].sort((left, right) => left.season - right.season);
  const training =
    options.intervalTrainingSeasons === undefined
      ? null
      : validateMarginalRosTrainingCohort(ordered, options.intervalTrainingSeasons);
  // The legacy evaluator validates the broader physical input. Marginal scaling additionally
  // requires actual schedule support within this exact forecast window and one player per block.
  const semanticIdentities = new Set<string>();
  for (const season of ordered) {
    for (const forecast of season.forecasts) {
      const games = forecast.evidence.availability.scheduledGames;
      if (games > Math.min(17, forecast.windowEndWeek - forecast.windowStartWeek + 1))
        throw new RangeError("Marginal scheduled games exceed the exact forecast window");
      const semanticIdentity = JSON.stringify([
        forecast.forecastSeason,
        forecast.asOfWeek,
        forecast.playerId,
      ]);
      if (semanticIdentities.has(semanticIdentity))
        throw new Error("Marginal evidence contains duplicate season/cutoff/player forecasts");
      semanticIdentities.add(semanticIdentity);
    }
  }

  const completedSeasons: number[] = [];
  const history = new Map<string, MarginalIntervalHistoryRow[]>();
  const candidates: MarginalRosCandidateEvaluation[] = [];
  const selected: MarginalRosCandidateEvaluation[] = [];
  const seasonPolicies: { season: number; policy: MarginalRosChampionPolicy }[] = [];
  for (const [index, season] of ordered.entries()) {
    const meanPolicy = legacyEvaluation.seasonPolicies[index]!.policy;
    const policy = policyFromPriorSeasons({
      forecastSeason: season.season,
      completedSeasons,
      history,
      candidates,
      selected,
      meanPolicy,
    });
    seasonPolicies.push({ season: season.season, policy });
    const choices = new Map(
      policy.choices.map((choice) => [cellKey(choice.position, choice.bucket), choice]),
    );
    const pending: MarginalIntervalHistoryRow[] = [];
    for (const forecast of season.forecasts) {
      const choice = choices.get(cellKey(forecast.position, bucket(forecast)))!;
      for (const strategy of STRATEGIES) {
        const candidate = evaluateCandidate(forecast, choice, strategy);
        candidates.push(candidate);
        if (strategy === choice.strategy) selected.push(candidate);
      }
    }
    // Resolve all rows together only after the original audit season has been evaluated. An
    // explicit training superset changes the interval fit alone, never mean choices or metrics.
    // Zero-game rows remain excluded without an epsilon or a substitution of expected games.
    for (const forecast of (training?.ordered[index] ?? season).forecasts) {
      if (forecast.evidence.availability.scheduledGames === 0) continue;
      const choice = choices.get(cellKey(forecast.position, bucket(forecast)))!;
      for (const strategy of STRATEGIES) {
        pending.push(
          historyRow(forecast, strategy, choice.intervalArtifacts[key(strategy)]!.context),
        );
      }
    }
    for (const row of pending) {
      const prior = history.get(row.seriesKey) ?? [];
      prior.push(row);
      history.set(row.seriesKey, prior);
    }
    completedSeasons.push(season.season);
  }
  return {
    policyVersion: FIRST_PARTY_ROS_MARGINAL_POLICY_VERSION,
    ...(training === null ? {} : { intervalTraining: training.provenance }),
    livePolicy: policyFromPriorSeasons({
      forecastSeason: options.forecastSeason,
      completedSeasons,
      history,
      candidates,
      selected,
      meanPolicy: legacyEvaluation.livePolicy,
    }),
    seasonPolicies,
    candidates,
    selected,
    legacyEvaluation,
  };
}
