import {
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  evaluateFirstPartyRosConvergence,
  firstPartyProjectionComponentsForPosition,
  firstPartyTeamDefenseProjectionComponents,
  observedScoringComponentIssues,
  projectionScoringProfileKey,
  rosProfileDefinitionFromKey,
  scoreProjectionStatComponents,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosOutcomeScore,
  type ProjectionScoringProfile,
} from "@laces-out/projections";

import {
  evaluateHistoricalRosForecasts,
  historicalRosBucket,
  historicalRosChecksum,
  historicalRosConvergenceChecksum,
  type ConvergenceStrategyEvidence,
  type HistoricalRosBacktestProgress,
  type HistoricalRosBacktestResult,
} from "./first-party-ros-backtest.js";
import {
  type RosHistoricalCorpus,
  type RosHistoricalCorpusForecast,
} from "./ros-historical-corpus.js";
import {
  scoreCachedRosHistoricalOutcome,
  scoreRetainedV12CachedRosHistoricalOutcome,
} from "./ros-historical-outcome-replay.js";
import type { RosOutcomeCache, RosOutcomeCacheKey } from "./ros-outcome-cache.js";
import type { RosDerivedOutcomeSource } from "./ros-derived-outcome-cache.js";

const PLAYER_ACTUAL_STAT_IDS = [
  ...new Set(
    (["QB", "RB", "WR", "TE", "K"] as const).flatMap(firstPartyProjectionComponentsForPosition),
  ),
];

function observedPoints(
  row: RosHistoricalCorpusForecast,
  profile: ProjectionScoringProfile,
  originalDstObservedSemantics: boolean,
): number {
  // Reconstruct only the authenticated original selector, preserving its historical missing-key
  // semantics. Corrected truth and all player labels retain the complete-observation guard.
  if (originalDstObservedSemantics && row.forecast.position === "DST") {
    const points = scoreProjectionStatComponents(row.actualComponents, profile);
    if (!Number.isFinite(points)) throw new RangeError("Original ROS observed outcome overflow");
    return points;
  }
  // A schedule with no games has no scoring opportunities. No appearances during a scheduled
  // window alone is not evidence of zero stats: that row still needs explicit observations.
  if (row.actualGames === 0 && Object.values(row.actualComponents).some((value) => value !== 0))
    throw new TypeError("ROS historical actual components contradict zero observed games");
  if (row.scheduledGames === 0 && row.actualGames === 0) return 0;
  const issues = observedScoringComponentIssues({
    components: row.actualComponents,
    profile,
    applicableStatIds:
      row.forecast.position === "DST"
        ? firstPartyTeamDefenseProjectionComponents()
        : PLAYER_ACTUAL_STAT_IDS,
  });
  if (issues.missingComponents.length > 0 || issues.invalidComponents.length > 0)
    throw new TypeError(
      `ROS historical actual components unavailable for ${row.forecast.playerId} at ${row.forecast.forecastSeason}:${row.forecast.asOfWeek}; missing=${issues.missingComponents.join(",")}; invalid=${issues.invalidComponents.join(",")}`,
    );
  const points = scoreProjectionStatComponents(row.actualComponents, profile);
  if (!Number.isFinite(points)) throw new RangeError("ROS observed outcome score overflow");
  return points;
}

function stratum(row: RosHistoricalCorpusForecast): string {
  const forecast = row.forecast;
  return `${forecast.forecastSeason}:${forecast.position}:${historicalRosBucket(forecast.windowStartWeek, forecast.windowEndWeek)}`;
}

/**
 * Reprices immutable joint paths and realized components, then uses the same chronological
 * policy selection/calibration/admission evidence gates as the original historical builder.
 * This path has no source fetch, weekly feature assembly, model fitting or scenario generation.
 */
export interface RosDerivedPopulationReplayInput {
  readonly corpus: RosHistoricalCorpus;
  readonly cache: RosOutcomeCache;
  readonly scoringProfile: ProjectionScoringProfile;
  readonly retainedV12?: boolean;
  readonly originalDstObservedSemantics?: "archived-missing-components-as-zero";
  readonly sourceForKey: ReadonlyMap<string, RosDerivedOutcomeSource>;
  readonly scoreMemo: Map<string, FirstPartyRosOutcomeScore>;
  readonly onProgress?: (event: HistoricalRosBacktestProgress) => void;
  readonly signal?: AbortSignal;
}
export interface RosDerivedConvergenceBinding {
  readonly stratum: string;
  readonly strategy: "contextual" | "availability-aware-recency";
  readonly physicalKey: RosOutcomeCacheKey;
  readonly manifestChecksum: string;
  readonly diagnostic: ReturnType<typeof evaluateFirstPartyRosConvergence>;
}
/** Reprices an already authenticated derived population; it does not authorize publication. */
export async function replayRosDerivedPopulation(input: RosDerivedPopulationReplayInput): Promise<{
  readonly result: HistoricalRosBacktestResult;
  readonly bindings: readonly RosDerivedConvergenceBinding[];
}> {
  const retainedV12 = input.retainedV12 ?? false;
  const bindings: RosDerivedConvergenceBinding[] = [];
  const { cache, signal } = input;
  signal?.throwIfAborted();
  // The package loader owns and authenticates the closed population before exposing caches.
  const corpus = input.corpus;
  const definition = rosProfileDefinitionFromKey(projectionScoringProfileKey(input.scoringProfile));
  const scoringProfile = definition.profile;
  // Validate every label before the first cache read, so a late missing component cannot be
  // silently turned into zero or discovered only after repricing the entire frozen ensemble.
  const actualPoints = corpus.forecasts.map((row) =>
    observedPoints(
      row,
      scoringProfile,
      input.originalDstObservedSemantics === "archived-missing-components-as-zero",
    ),
  );
  const numericScoringKey = historicalRosChecksum(
    scoringProfile.rules.map(({ statDefinition, ...rule }) => {
      void statDefinition;
      return rule;
    }),
  );
  const score = async (
    row: RosHistoricalCorpusForecast,
    strategy: "contextual" | "availability-aware-recency",
    scenarioCount: number,
  ) => {
    signal?.throwIfAborted();
    const key = strategy === "contextual" ? row.contextualKey : row.recencyKey;
    const source = input.sourceForKey.get(`${key.modelVersion}:${key.identity}`);
    if (!source) throw new Error("Missing authenticated physical scoring reference");
    const identity = `${source.sha256}:${numericScoringKey}:${scenarioCount}`;
    const memo = input.scoreMemo.get(identity);
    if (memo) return { ...memo, scoringProfileKey: definition.scoringProfileKey };
    const result = await (
      retainedV12 ? scoreRetainedV12CachedRosHistoricalOutcome : scoreCachedRosHistoricalOutcome
    )({
      cache,
      key,
      scoringProfile,
      scenarioCount,
      expected: {
        ...row.forecast,
        strategy,
        weeklyModelVersion: corpus.weeklyModelVersion,
        scheduledGames: row.scheduledGames,
      },
      ...(signal ? { signal } : {}),
    });
    if (input.scoreMemo.size >= 30_000) throw new Error("Derived scalar score memo exceeded bound");
    input.scoreMemo.set(identity, result);
    return result;
  };
  const scores: Array<{
    readonly contextual: FirstPartyRosOutcomeScore;
    readonly recency: FirstPartyRosOutcomeScore;
  }> = [];
  const samples = new Map<
    string,
    { readonly row: RosHistoricalCorpusForecast; readonly index: number; readonly hash: string }
  >();
  for (const [index, row] of corpus.forecasts.entries()) {
    signal?.throwIfAborted();
    const contextual = await score(row, "contextual", FIRST_PARTY_ROS_DEFAULT_SCENARIOS);
    const recency = await score(
      row,
      "availability-aware-recency",
      FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
    );
    scores.push({ contextual, recency });
    const key = stratum(row);
    const candidateHash = historicalRosChecksum(row.forecast.inputChecksum);
    const existing = samples.get(key);
    // Same checksum ordering and stable tie behavior as convergenceEvidence in the builder.
    if (!existing || candidateHash.localeCompare(existing.hash) < 0)
      samples.set(key, { row, index, hash: candidateHash });
  }
  input.onProgress?.({ stage: "season-forecasts-ready", forecasts: scores.length });
  signal?.throwIfAborted();
  input.onProgress?.({ stage: "convergence-started", forecasts: scores.length });
  const convergence = new Map<
    string,
    {
      readonly contextual: ConvergenceStrategyEvidence;
      readonly recency: ConvergenceStrategyEvidence;
    }
  >();
  for (const [key, sample] of samples) {
    signal?.throwIfAborted();
    const evidence = async (
      strategy: "contextual" | "availability-aware-recency",
    ): Promise<ConvergenceStrategyEvidence> => {
      const release =
        strategy === "contextual"
          ? scores[sample.index]!.contextual
          : scores[sample.index]!.recency;
      const reference = await score(
        sample.row,
        strategy,
        FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
      );
      const diagnostic = evaluateFirstPartyRosConvergence({
        position: sample.row.forecast.position,
        release,
        reference,
      });
      const physicalKey =
        strategy === "contextual" ? sample.row.contextualKey : sample.row.recencyKey;
      const source = input.sourceForKey.get(`${physicalKey.modelVersion}:${physicalKey.identity}`)!;
      bindings.push({
        stratum: key,
        strategy,
        physicalKey: source.key,
        manifestChecksum: source.manifestChecksum,
        diagnostic,
      });
      return {
        state: diagnostic.state,
        checksum: historicalRosConvergenceChecksum({
          season: sample.row.forecast.forecastSeason,
          position: sample.row.forecast.position,
          bucket: historicalRosBucket(
            sample.row.forecast.windowStartWeek,
            sample.row.forecast.windowEndWeek,
          ),
          strategy,
          diagnostics: [diagnostic],
        }),
        worstMetric: diagnostic.worstMetric,
        worstToleranceRatio: diagnostic.worstToleranceRatio,
      };
    };
    convergence.set(key, {
      contextual: await evidence("contextual"),
      recency: await evidence("availability-aware-recency"),
    });
  }
  input.onProgress?.({
    stage: "convergence-ready",
    forecasts: scores.length,
    convergenceStrata: convergence.size,
  });
  const forecasts = corpus.forecasts.map((row, index): FirstPartyRosHeldOutForecast => {
    const score = scores[index]!;
    const evidence = convergence.get(stratum(row))!;
    return {
      ...row.forecast,
      scoringProfileKey: definition.scoringProfileKey,
      contextual: {
        meanPoints: score.contextual.meanPoints,
        p15Points: score.contextual.p15Points,
        p50Points: score.contextual.p50Points,
        p85Points: score.contextual.p85Points,
      },
      recency: {
        meanPoints: score.recency.meanPoints,
        p15Points: score.recency.p15Points,
        p50Points: score.recency.p50Points,
        p85Points: score.recency.p85Points,
      },
      actualPoints: actualPoints[index]!,
      evidence: {
        coverage: row.coverage,
        availability: {
          scheduledGames: row.scheduledGames,
          actualGames: row.actualGames,
          contextualExpectedGames: score.contextual.expectedGames,
          recencyExpectedGames: score.recency.expectedGames,
        },
        convergence: {
          contextual: {
            state: evidence.contextual.state,
            diagnosticChecksum: evidence.contextual.checksum,
          },
          recency: { state: evidence.recency.state, diagnosticChecksum: evidence.recency.checksum },
        },
      },
    };
  });
  signal?.throwIfAborted();
  const result = evaluateHistoricalRosForecasts({
    ...(retainedV12 ? { evaluationModel: "retained-v12" as const } : {}),
    forecasts,
    options: corpus.options,
    qualifiedSeasons: corpus.seasons,
    skippedForecasts: corpus.skippedForecasts,
    kickerFamilyAudits: corpus.kickerFamilyAudit,
    convergence,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
  return { result, bindings };
}
