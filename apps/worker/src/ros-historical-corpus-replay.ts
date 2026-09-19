import {
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  evaluateFirstPartyRosConvergence,
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
  snapshotRosHistoricalCorpus,
  snapshotRetainedV12RosHistoricalCorpus,
  retainedV12RosHistoricalCorpusIdentity,
  type RosHistoricalCorpus,
  type RosHistoricalCorpusForecast,
} from "./ros-historical-corpus.js";
import {
  scoreCachedRosHistoricalOutcome,
  scoreRetainedV12CachedRosHistoricalOutcome,
} from "./ros-historical-outcome-replay.js";
import type { RosOutcomeCache } from "./ros-outcome-cache.js";

function stratum(row: RosHistoricalCorpusForecast): string {
  const forecast = row.forecast;
  return `${forecast.forecastSeason}:${forecast.position}:${historicalRosBucket(forecast.windowStartWeek, forecast.windowEndWeek)}`;
}

/**
 * Reprices immutable joint paths and realized components, then uses the same chronological
 * policy selection/calibration/admission evidence gates as the original historical builder.
 * This path has no source fetch, weekly feature assembly, model fitting or scenario generation.
 */
interface RosHistoricalCorpusReplayInput {
  readonly corpus: RosHistoricalCorpus;
  readonly cache: RosOutcomeCache;
  readonly scoringProfile: ProjectionScoringProfile;
  readonly onProgress?: (event: HistoricalRosBacktestProgress) => void;
  readonly signal?: AbortSignal;
}

export async function replayRosHistoricalCorpus(
  input: RosHistoricalCorpusReplayInput,
): Promise<HistoricalRosBacktestResult> {
  input.signal?.throwIfAborted();
  return replayCorpus({ ...input, corpus: snapshotRosHistoricalCorpus(input.corpus) }, false);
}

/** Explicit pinned previous-model benchmark. Missing paths never trigger simulation or writes. */
export async function replayRetainedV12RosHistoricalCorpus(
  input: RosHistoricalCorpusReplayInput & {
    readonly expectedIdentity: string;
  },
): Promise<HistoricalRosBacktestResult> {
  input.signal?.throwIfAborted();
  const corpus = snapshotRetainedV12RosHistoricalCorpus(input.corpus);
  if (retainedV12RosHistoricalCorpusIdentity(corpus) !== input.expectedIdentity)
    throw new TypeError("Retained v12 historical corpus identity does not match pinned dependency");
  return replayCorpus({ ...input, corpus }, true);
}

async function replayCorpus(
  input: RosHistoricalCorpusReplayInput,
  retainedV12: boolean,
): Promise<HistoricalRosBacktestResult> {
  const { cache, signal } = input;
  signal?.throwIfAborted();
  // Both public entry points already own a bounded snapshot before the first cache await.
  const corpus = input.corpus;
  const definition = rosProfileDefinitionFromKey(projectionScoringProfileKey(input.scoringProfile));
  const scoringProfile = definition.profile;
  const score = (
    row: RosHistoricalCorpusForecast,
    strategy: "contextual" | "availability-aware-recency",
    scenarioCount: number,
  ) =>
    (retainedV12 ? scoreRetainedV12CachedRosHistoricalOutcome : scoreCachedRosHistoricalOutcome)({
      cache,
      key: strategy === "contextual" ? row.contextualKey : row.recencyKey,
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
    const actualPoints = scoreProjectionStatComponents(row.actualComponents, scoringProfile);
    if (!Number.isFinite(actualPoints)) throw new RangeError("ROS observed outcome score overflow");
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
      actualPoints,
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
  return evaluateHistoricalRosForecasts({
    ...(retainedV12 ? { evaluationModel: "retained-v12" as const } : {}),
    forecasts,
    options: corpus.options,
    qualifiedSeasons: corpus.seasons,
    skippedForecasts: corpus.skippedForecasts,
    kickerFamilyAudits: corpus.kickerFamilyAudit,
    convergence,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
}
