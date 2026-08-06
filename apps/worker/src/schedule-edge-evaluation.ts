import { createHash } from "node:crypto";

import {
  calculateScheduleEdgeDefenseRatings,
  type ScheduleEdgeDefenseRating,
  type ScheduleEdgeDefenseRatingsResult,
  type ScheduleEdgeGamePositionTotalsResult,
  type ScheduleEdgePolicy,
  type ScheduleEdgePosition,
} from "@laces-out/league-analytics";

export const SCHEDULE_EDGE_EVALUATION_VERSION = "schedule-edge-walk-forward-v1" as const;

export type ScheduleEdgeEvaluationProfileName = "standard" | "half-ppr" | "full-ppr";
export type ScheduleEdgeEvaluationEstimator = "raw" | "opponent-adjusted";

export interface ScheduleEdgeEvaluationProfile {
  readonly name: ScheduleEdgeEvaluationProfileName;
  /** Hash of the exact pinned schedule, stat, and weekly-roster artifacts used for this profile. */
  readonly evidenceChecksum: string;
  readonly totals: ScheduleEdgeGamePositionTotalsResult;
  readonly playerGames: readonly ScheduleEdgePlayerGamePoint[];
}

export interface ScheduleEdgePlayerGamePoint {
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly playerId: string;
  readonly offenseTeam: string;
  readonly defenseTeam: string;
  readonly position: ScheduleEdgePosition;
  readonly points: number;
}

export interface ScheduleEdgeEvaluationCandidate {
  readonly id: string;
  readonly estimator: ScheduleEdgeEvaluationEstimator;
  readonly policy: ScheduleEdgePolicy;
}

export interface ScheduleEdgeEvaluationInput {
  readonly profiles: readonly ScheduleEdgeEvaluationProfile[];
  readonly candidates: readonly ScheduleEdgeEvaluationCandidate[];
  readonly heldOutSeasons: readonly number[];
  readonly minimumSamplesPerCell?: number;
  readonly minimumDirectionalSamplesPerCell?: number;
  readonly minimumOrderedSeasons?: number;
  readonly minimumRankCorrelation?: number;
  readonly minimumBucketSpread?: number;
}

export interface ScheduleEdgeEvaluationObservation {
  readonly candidateId: string;
  readonly profile: ScheduleEdgeEvaluationProfileName;
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly offenseTeam: string;
  readonly defenseTeam: string;
  readonly position: ScheduleEdgePosition;
  readonly percentile: number;
  readonly predictedDifferential: number;
  readonly label: "favorable" | "neutral" | "difficult" | "unavailable";
  readonly actualPoints: number;
  readonly playerExpectation: number;
  readonly actualResidual: number;
  readonly phase: "early" | "late";
}

export interface ScheduleEdgeEvaluationCell {
  readonly candidateId: string;
  readonly profile: ScheduleEdgeEvaluationProfileName;
  readonly position: ScheduleEdgePosition;
  readonly samples: number;
  readonly eligibleSamples: number;
  readonly directionalSamples: number;
  readonly seasons: number;
  readonly earlySamples: number;
  readonly lateSamples: number;
  readonly rankCorrelation: number | null;
  readonly bucketMeans: {
    readonly difficult: number | null;
    readonly neutral: number | null;
    readonly favorable: number | null;
  };
  readonly percentileBandMeans: {
    readonly difficult: number | null;
    readonly neutral: number | null;
    readonly favorable: number | null;
  };
  readonly bucketSamples: {
    readonly difficult: number;
    readonly neutral: number;
    readonly favorable: number;
  };
  readonly favorableMinusDifficult: number | null;
  readonly orderedSeasons: number;
  readonly evaluatedSeasons: number;
  readonly earlyRankCorrelation: number | null;
  readonly lateRankCorrelation: number | null;
}

export interface ScheduleEdgeCandidateSummary {
  readonly candidateId: string;
  readonly estimator: ScheduleEdgeEvaluationEstimator;
  readonly cells: number;
  readonly samples: number;
  readonly directionalSamples: number;
  readonly meanRankCorrelation: number | null;
  readonly meanBucketSpread: number | null;
  readonly meanEarlyRankCorrelation: number | null;
  readonly score: number | null;
}

export interface ScheduleEdgePositionGate {
  readonly position: ScheduleEdgePosition;
  readonly state: "validated" | "descriptive-only";
  readonly samples: number;
  readonly directionalSamples: number;
  readonly profilesPassing: number;
  readonly profilesRequired: number;
  readonly reasons: readonly string[];
}

export interface ScheduleEdgeHistoricalEvaluation {
  readonly version: typeof SCHEDULE_EDGE_EVALUATION_VERSION;
  readonly evidenceChecksum: string;
  readonly heldOutSeasons: readonly number[];
  readonly selectedCandidateId: string;
  readonly selectedPolicy: ScheduleEdgePolicy;
  readonly observations: number;
  readonly cells: readonly ScheduleEdgeEvaluationCell[];
  readonly candidates: readonly ScheduleEdgeCandidateSummary[];
  readonly positionGates: readonly ScheduleEdgePositionGate[];
  readonly leakagePolicy: {
    readonly defenseInputs: "strictly-before-target-week";
    readonly playerBaseline: "up-to-eight-games-strictly-before-target-week";
    readonly targetOutcomeUse: "evaluation-only";
    readonly futureSeasonUse: false;
  };
  readonly thresholds: {
    readonly minimumSamplesPerCell: number;
    readonly minimumDirectionalSamplesPerCell: number;
    readonly minimumOrderedSeasons: number;
    readonly minimumRankCorrelation: number;
    readonly minimumBucketSpread: number;
  };
}

interface EvaluationThresholds {
  readonly minimumSamplesPerCell: number;
  readonly minimumDirectionalSamplesPerCell: number;
  readonly minimumOrderedSeasons: number;
  readonly minimumRankCorrelation: number;
  readonly minimumBucketSpread: number;
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

function finiteMean(values: readonly (number | null)[]): number | null {
  return mean(values.filter((value): value is number => value !== null && Number.isFinite(value)));
}

function compareObservations(
  left: ScheduleEdgeEvaluationObservation,
  right: ScheduleEdgeEvaluationObservation,
): number {
  return (
    left.season - right.season ||
    left.week - right.week ||
    left.gameId.localeCompare(right.gameId) ||
    left.offenseTeam.localeCompare(right.offenseTeam) ||
    left.position.localeCompare(right.position)
  );
}

function validateInput(input: ScheduleEdgeEvaluationInput): EvaluationThresholds {
  if (input.profiles.length === 0) throw new Error("At least one scoring profile is required.");
  if (input.candidates.length === 0) throw new Error("At least one policy candidate is required.");
  if (new Set(input.profiles.map((profile) => profile.name)).size !== input.profiles.length) {
    throw new Error("Evaluation profile names must be unique.");
  }
  if (input.profiles.some((profile) => !/^[a-f0-9]{64}$/u.test(profile.evidenceChecksum))) {
    throw new Error("Evaluation profile evidence checksums must be SHA-256 digests.");
  }
  for (const profile of input.profiles) {
    if (profile.playerGames.length === 0) {
      throw new Error(`${profile.name} requires player-game outcomes.`);
    }
  }
  if (new Set(input.candidates.map((candidate) => candidate.id)).size !== input.candidates.length) {
    throw new Error("Evaluation candidate IDs must be unique.");
  }
  if (
    input.heldOutSeasons.length === 0 ||
    input.heldOutSeasons.some(
      (season) => !Number.isSafeInteger(season) || season < 1999 || season > 2200,
    )
  ) {
    throw new Error("Held-out seasons must be valid NFL seasons.");
  }
  const thresholds = {
    minimumSamplesPerCell: input.minimumSamplesPerCell ?? 300,
    minimumDirectionalSamplesPerCell: input.minimumDirectionalSamplesPerCell ?? 80,
    minimumOrderedSeasons: input.minimumOrderedSeasons ?? 2,
    minimumRankCorrelation: input.minimumRankCorrelation ?? 0.02,
    minimumBucketSpread: input.minimumBucketSpread ?? 0.35,
  };
  if (
    !Number.isSafeInteger(thresholds.minimumSamplesPerCell) ||
    thresholds.minimumSamplesPerCell < 1
  ) {
    throw new Error("minimumSamplesPerCell must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(thresholds.minimumDirectionalSamplesPerCell) ||
    thresholds.minimumDirectionalSamplesPerCell < 1
  ) {
    throw new Error("minimumDirectionalSamplesPerCell must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(thresholds.minimumOrderedSeasons) ||
    thresholds.minimumOrderedSeasons < 1 ||
    thresholds.minimumOrderedSeasons > input.heldOutSeasons.length
  ) {
    throw new Error("minimumOrderedSeasons must fit within the held-out season count.");
  }
  if (
    !Number.isFinite(thresholds.minimumRankCorrelation) ||
    thresholds.minimumRankCorrelation < -1 ||
    thresholds.minimumRankCorrelation > 1
  ) {
    throw new Error("minimumRankCorrelation must be between -1 and 1.");
  }
  if (!Number.isFinite(thresholds.minimumBucketSpread) || thresholds.minimumBucketSpread < 0) {
    throw new Error("minimumBucketSpread must be non-negative.");
  }
  return thresholds;
}

function midranks(values: readonly number[]): readonly number[] {
  const ordered = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = Array<number>(values.length);
  for (let index = 0; index < ordered.length;) {
    let end = index + 1;
    while (end < ordered.length && ordered[end]!.value === ordered[index]!.value) end += 1;
    const rank = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor += 1) {
      ranks[ordered[cursor]!.index] = rank;
    }
    index = end;
  }
  return ranks;
}

function pearson(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  if (leftMean === null || rightMean === null) return null;
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index]! - leftMean;
    const rightDelta = right[index]! - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquare += leftDelta ** 2;
    rightSquare += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator === 0 ? null : numerator / denominator;
}

function spearman(rows: readonly ScheduleEdgeEvaluationObservation[]): number | null {
  return pearson(
    midranks(rows.map((row) => row.predictedDifferential)),
    midranks(rows.map((row) => row.actualResidual)),
  );
}

function rawPercentiles(
  ratings: readonly ScheduleEdgeDefenseRating[],
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const position of ["QB", "RB", "WR", "TE"] as const) {
    const peers = ratings.filter(
      (rating) => rating.position === position && rating.rawPointsPerGame !== null,
    );
    for (const rating of peers) {
      result.set(
        `${rating.defenseTeam}\u0000${rating.position}`,
        percentile(
          rating.rawPointsPerGame!,
          peers.map((peer) => peer.rawPointsPerGame!),
        ),
      );
    }
  }
  return result;
}

function percentile(value: number, values: readonly number[]): number {
  if (values.length <= 1) return 50;
  const lower = values.filter((candidate) => candidate < value).length;
  const tied = values.filter((candidate) => candidate === value).length;
  return ((lower + (tied - 1) / 2) / (values.length - 1)) * 100;
}

function playerGameKey(game: ScheduleEdgePlayerGamePoint): string {
  return `${game.season}\u0000${game.week}\u0000${game.gameId}\u0000${game.playerId}\u0000${game.position}`;
}

function buildPlayerExpectations(
  games: readonly ScheduleEdgePlayerGamePoint[],
): ReadonlyMap<string, number> {
  const expectations = new Map<string, number>();
  const history = new Map<string, number[]>();
  const byWeek = new Map<string, ScheduleEdgePlayerGamePoint[]>();
  for (const game of games) {
    const key = `${game.season}\u0000${String(game.week).padStart(2, "0")}`;
    byWeek.set(key, [...(byWeek.get(key) ?? []), game]);
  }
  for (const weekGames of [...byWeek.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, rows]) => rows)) {
    for (const game of weekGames) {
      const playerKey = `${game.playerId}\u0000${game.position}`;
      const prior = history.get(playerKey) ?? [];
      const expectation = prior.length < 2 ? null : mean(prior.slice(-8));
      if (expectation !== null) expectations.set(playerGameKey(game), expectation);
    }
    for (const game of weekGames) {
      const playerKey = `${game.playerId}\u0000${game.position}`;
      const prior = history.get(playerKey) ?? [];
      history.set(playerKey, [...prior, game.points].slice(-8));
    }
  }
  return expectations;
}

function observationsForCandidate(
  profile: ScheduleEdgeEvaluationProfile,
  candidate: ScheduleEdgeEvaluationCandidate,
  heldOutSeasons: ReadonlySet<number>,
  playerExpectations: ReadonlyMap<string, number>,
  ratingCache: Map<string, ScheduleEdgeDefenseRatingsResult>,
): readonly ScheduleEdgeEvaluationObservation[] {
  const observations: ScheduleEdgeEvaluationObservation[] = [];
  const availableTargets = profile.playerGames.filter((game) => heldOutSeasons.has(game.season));
  for (const season of [...heldOutSeasons].sort((left, right) => left - right)) {
    const seasonWeeks = [
      ...new Set(
        availableTargets.filter((target) => target.season === season).map((target) => target.week),
      ),
    ].sort((left, right) => left - right);
    for (const week of seasonWeeks) {
      if (week <= 1) continue;
      const cacheKey = `${profile.name}\u0000${JSON.stringify(candidate.policy)}\u0000${season}\u0000${week - 1}`;
      const result =
        ratingCache.get(cacheKey) ??
        calculateScheduleEdgeDefenseRatings({
          targetSeason: season,
          throughWeek: week - 1,
          totals: profile.totals,
          policy: candidate.policy,
        });
      ratingCache.set(cacheKey, result);
      const raw = rawPercentiles(result.ratings);
      const ratings = new Map(
        result.ratings.map((rating) => [`${rating.defenseTeam}\u0000${rating.position}`, rating]),
      );
      for (const target of availableTargets.filter(
        (row) => row.season === season && row.week === week,
      )) {
        const rating = ratings.get(`${target.defenseTeam}\u0000${target.position}`);
        const expectation = playerExpectations.get(playerGameKey(target)) ?? null;
        if (!rating || expectation === null) continue;
        const predicted =
          candidate.estimator === "raw" ? rating.rawPointsPerGame : rating.adjustedPointsPerGame;
        const baseline = rating.leagueMeanPointsPerGame;
        const percentile =
          candidate.estimator === "raw"
            ? (raw.get(`${rating.defenseTeam}\u0000${rating.position}`) ?? null)
            : rating.percentile;
        if (predicted === null || baseline === null || percentile === null) continue;
        const predictedDifferential = predicted - baseline;
        const labelEligible =
          rating.currentGames >= candidate.policy.minimumCurrentSeasonGamesForLabel ||
          (rating.currentGames === 0 && candidate.policy.allowPriorOnlyLabels);
        const minimum = candidate.policy.minimumPointDifferentialByPosition[target.position];
        const label = !labelEligible
          ? "unavailable"
          : percentile >= 67 && predictedDifferential >= minimum
            ? "favorable"
            : percentile <= 33 && predictedDifferential <= -minimum
              ? "difficult"
              : "neutral";
        observations.push({
          candidateId: candidate.id,
          profile: profile.name,
          season,
          week,
          gameId: target.gameId,
          offenseTeam: target.offenseTeam,
          defenseTeam: target.defenseTeam,
          position: target.position,
          percentile,
          predictedDifferential,
          label,
          actualPoints: target.points,
          playerExpectation: expectation,
          actualResidual: target.points - expectation,
          phase: week <= 4 ? "early" : "late",
        });
      }
    }
  }
  return observations.sort(compareObservations);
}

function clusterPlayerObservations(
  rows: readonly ScheduleEdgeEvaluationObservation[],
): readonly ScheduleEdgeEvaluationObservation[] {
  const clusters = new Map<string, ScheduleEdgeEvaluationObservation[]>();
  for (const row of rows) {
    const key = [
      row.candidateId,
      row.profile,
      row.season,
      row.week,
      row.gameId,
      row.offenseTeam,
      row.defenseTeam,
      row.position,
    ].join("\u0000");
    clusters.set(key, [...(clusters.get(key) ?? []), row]);
  }
  return [...clusters.values()]
    .map((cluster) => {
      const first = cluster[0]!;
      return {
        ...first,
        predictedDifferential:
          mean(cluster.map((row) => row.predictedDifferential)) ?? first.predictedDifferential,
        actualPoints: mean(cluster.map((row) => row.actualPoints)) ?? first.actualPoints,
        playerExpectation:
          mean(cluster.map((row) => row.playerExpectation)) ?? first.playerExpectation,
        actualResidual: mean(cluster.map((row) => row.actualResidual)) ?? first.actualResidual,
      };
    })
    .sort(compareObservations);
}

function cellFor(
  candidateId: string,
  profile: ScheduleEdgeEvaluationProfileName,
  position: ScheduleEdgePosition,
  rows: readonly ScheduleEdgeEvaluationObservation[],
  seasons: readonly number[],
): ScheduleEdgeEvaluationCell {
  const selected = clusterPlayerObservations(
    rows.filter(
      (row) =>
        row.candidateId === candidateId && row.profile === profile && row.position === position,
    ),
  );
  const eligible = selected.filter((row) => row.label !== "unavailable");
  const buckets = {
    difficult: eligible.filter((row) => row.label === "difficult"),
    neutral: eligible.filter((row) => row.label === "neutral"),
    favorable: eligible.filter((row) => row.label === "favorable"),
  };
  const percentileBands = {
    difficult: selected.filter((row) => row.percentile <= 33),
    neutral: selected.filter((row) => row.percentile > 33 && row.percentile < 67),
    favorable: selected.filter((row) => row.percentile >= 67),
  };
  const bucketMeans = {
    difficult: mean(buckets.difficult.map((row) => row.actualResidual)),
    neutral: mean(buckets.neutral.map((row) => row.actualResidual)),
    favorable: mean(buckets.favorable.map((row) => row.actualResidual)),
  };
  const percentileBandMeans = {
    difficult: mean(percentileBands.difficult.map((row) => row.actualResidual)),
    neutral: mean(percentileBands.neutral.map((row) => row.actualResidual)),
    favorable: mean(percentileBands.favorable.map((row) => row.actualResidual)),
  };
  const orderedSeasons = seasons.filter((season) => {
    const seasonRows = eligible.filter((row) => row.season === season);
    const difficult = mean(
      seasonRows.filter((row) => row.label === "difficult").map((row) => row.actualResidual),
    );
    const neutral = mean(
      seasonRows.filter((row) => row.label === "neutral").map((row) => row.actualResidual),
    );
    const favorable = mean(
      seasonRows.filter((row) => row.label === "favorable").map((row) => row.actualResidual),
    );
    return (
      difficult !== null &&
      neutral !== null &&
      favorable !== null &&
      favorable > neutral &&
      neutral > difficult
    );
  }).length;
  return {
    candidateId,
    profile,
    position,
    samples: selected.length,
    eligibleSamples: eligible.length,
    directionalSamples: buckets.difficult.length + buckets.favorable.length,
    seasons: new Set(selected.map((row) => row.season)).size,
    earlySamples: selected.filter((row) => row.phase === "early").length,
    lateSamples: selected.filter((row) => row.phase === "late").length,
    rankCorrelation: spearman(selected),
    bucketMeans,
    percentileBandMeans,
    bucketSamples: {
      difficult: buckets.difficult.length,
      neutral: buckets.neutral.length,
      favorable: buckets.favorable.length,
    },
    favorableMinusDifficult:
      bucketMeans.favorable === null || bucketMeans.difficult === null
        ? null
        : bucketMeans.favorable - bucketMeans.difficult,
    orderedSeasons,
    evaluatedSeasons: seasons.length,
    earlyRankCorrelation: spearman(selected.filter((row) => row.phase === "early")),
    lateRankCorrelation: spearman(selected.filter((row) => row.phase === "late")),
  };
}

function summarizeCandidate(
  candidate: ScheduleEdgeEvaluationCandidate,
  cells: readonly ScheduleEdgeEvaluationCell[],
): ScheduleEdgeCandidateSummary {
  const selected = cells.filter((cell) => cell.candidateId === candidate.id);
  const meanRankCorrelation = finiteMean(selected.map((cell) => cell.rankCorrelation));
  const meanBucketSpread = finiteMean(selected.map((cell) => cell.favorableMinusDifficult));
  const meanEarlyRankCorrelation = finiteMean(selected.map((cell) => cell.earlyRankCorrelation));
  const samples = selected.reduce((sum, cell) => sum + cell.samples, 0);
  const directionalSamples = selected.reduce((sum, cell) => sum + cell.directionalSamples, 0);
  const directionalCoverage = samples === 0 ? 0 : directionalSamples / samples;
  const score =
    meanRankCorrelation === null || meanBucketSpread === null
      ? null
      : meanRankCorrelation +
        Math.max(-1, Math.min(1, meanBucketSpread / 10)) * 0.05 +
        Math.min(1, directionalCoverage / 0.25) * 0.005;
  return {
    candidateId: candidate.id,
    estimator: candidate.estimator,
    cells: selected.length,
    samples,
    directionalSamples,
    meanRankCorrelation,
    meanBucketSpread,
    meanEarlyRankCorrelation,
    score,
  };
}

function selectCandidate(
  candidates: readonly ScheduleEdgeEvaluationCandidate[],
  summaries: readonly ScheduleEdgeCandidateSummary[],
): ScheduleEdgeEvaluationCandidate {
  const ordered = [...candidates].sort((left, right) => {
    const leftSummary = summaries.find((summary) => summary.candidateId === left.id);
    const rightSummary = summaries.find((summary) => summary.candidateId === right.id);
    const scoreDifference =
      (rightSummary?.score ?? Number.NEGATIVE_INFINITY) -
      (leftSummary?.score ?? Number.NEGATIVE_INFINITY);
    if (scoreDifference !== 0) return scoreDifference;
    return left.id.localeCompare(right.id);
  });
  let best = ordered[0]!;
  if (best.estimator === "raw") {
    const bestRawSummary = summaries.find((summary) => summary.candidateId === best.id);
    const adjusted = candidates
      .filter(
        (candidate) =>
          candidate.estimator === "opponent-adjusted" && candidate.policy.recencyDecay === null,
      )
      .sort((left, right) => {
        const leftScore =
          summaries.find((summary) => summary.candidateId === left.id)?.score ?? -Infinity;
        const rightScore =
          summaries.find((summary) => summary.candidateId === right.id)?.score ?? -Infinity;
        return rightScore - leftScore || left.id.localeCompare(right.id);
      })[0];
    const adjustedSummary = summaries.find((summary) => summary.candidateId === adjusted?.id);
    const adjustedWithinTieBand =
      (adjustedSummary?.score ?? -Infinity) >= (bestRawSummary?.score ?? -Infinity) - 0.005;
    const adjustedEarlyNotWorse =
      (adjustedSummary?.meanEarlyRankCorrelation ?? -Infinity) >=
      (bestRawSummary?.meanEarlyRankCorrelation ?? -Infinity) - 0.005;
    if (adjusted && adjustedWithinTieBand && adjustedEarlyNotWorse) best = adjusted;
  }
  if (best.policy.recencyDecay === null) return best;
  const equalWeightPeer = candidates.find(
    (candidate) =>
      candidate.estimator === best.estimator &&
      candidate.policy.recencyDecay === null &&
      candidate.policy.offenseShrinkageGames === best.policy.offenseShrinkageGames &&
      candidate.policy.defenseShrinkageGames === best.policy.defenseShrinkageGames &&
      candidate.policy.priorSeasonPseudoGames === best.policy.priorSeasonPseudoGames &&
      candidate.policy.minimumCurrentSeasonGamesForLabel ===
        best.policy.minimumCurrentSeasonGamesForLabel &&
      JSON.stringify(candidate.policy.minimumPointDifferentialByPosition) ===
        JSON.stringify(best.policy.minimumPointDifferentialByPosition),
  );
  if (!equalWeightPeer) return best;
  const bestSummary = summaries.find((summary) => summary.candidateId === best.id);
  const peerSummary = summaries.find((summary) => summary.candidateId === equalWeightPeer.id);
  const recencyImprovement = (bestSummary?.score ?? -Infinity) - (peerSummary?.score ?? -Infinity);
  const earlyNotWorse =
    (bestSummary?.meanEarlyRankCorrelation ?? -Infinity) >=
    (peerSummary?.meanEarlyRankCorrelation ?? -Infinity) - 0.005;
  return recencyImprovement >= 0.005 && earlyNotWorse ? best : equalWeightPeer;
}

function stableEvidence(
  input: ScheduleEdgeEvaluationInput,
  selectedCandidateId: string,
  cells: readonly ScheduleEdgeEvaluationCell[],
  thresholds: EvaluationThresholds,
): string {
  return JSON.stringify({
    version: SCHEDULE_EDGE_EVALUATION_VERSION,
    heldOutSeasons: [...input.heldOutSeasons].sort((left, right) => left - right),
    selectedCandidateId,
    sources: input.profiles
      .map((profile) => ({
        name: profile.name,
        evidenceChecksum: profile.evidenceChecksum,
        scoringProfileKey: profile.totals.scoringProfileKey,
        playerGames: profile.playerGames.length,
        completeSlices: profile.totals.completeSlices,
        incompleteSlices: profile.totals.incompleteSlices,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    candidates: input.candidates
      .map((candidate) => ({
        id: candidate.id,
        estimator: candidate.estimator,
        policy: candidate.policy,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    cells,
    thresholds,
  });
}

export function evaluateScheduleEdgeHistory(
  input: ScheduleEdgeEvaluationInput,
): ScheduleEdgeHistoricalEvaluation {
  const thresholds = validateInput(input);
  const heldOut = new Set(input.heldOutSeasons);
  const ratingCache = new Map<string, ScheduleEdgeDefenseRatingsResult>();
  const observations = input.profiles.flatMap((profile) => {
    const expectations = buildPlayerExpectations(profile.playerGames);
    return input.candidates.flatMap((candidate) =>
      observationsForCandidate(profile, candidate, heldOut, expectations, ratingCache),
    );
  });
  const cells = input.candidates.flatMap((candidate) =>
    input.profiles.flatMap((profile) =>
      profile.totals.positions.map((position) =>
        cellFor(candidate.id, profile.name, position, observations, input.heldOutSeasons),
      ),
    ),
  );
  const candidateSummaries = input.candidates.map((candidate) =>
    summarizeCandidate(candidate, cells),
  );
  const selected = selectCandidate(input.candidates, candidateSummaries);
  const selectedCells = cells.filter((cell) => cell.candidateId === selected.id);
  const positions = [
    ...new Set(input.profiles.flatMap((profile) => profile.totals.positions)),
  ].sort();
  const positionGates = positions.map((position): ScheduleEdgePositionGate => {
    const profileCells = selectedCells.filter((cell) => cell.position === position);
    const failed = profileCells.flatMap((cell) => {
      const reasons = [
        ...(cell.eligibleSamples < thresholds.minimumSamplesPerCell
          ? [`${cell.profile}: fewer than ${thresholds.minimumSamplesPerCell} samples`]
          : []),
        ...(cell.directionalSamples < thresholds.minimumDirectionalSamplesPerCell
          ? [
              `${cell.profile}: fewer than ${thresholds.minimumDirectionalSamplesPerCell} directional samples`,
            ]
          : []),
        ...((cell.rankCorrelation ?? -Infinity) < thresholds.minimumRankCorrelation
          ? [`${cell.profile}: rank correlation below ${thresholds.minimumRankCorrelation}`]
          : []),
        ...((cell.favorableMinusDifficult ?? -Infinity) < thresholds.minimumBucketSpread
          ? [`${cell.profile}: favorable/difficult spread below ${thresholds.minimumBucketSpread}`]
          : []),
        ...(cell.orderedSeasons < thresholds.minimumOrderedSeasons
          ? [
              `${cell.profile}: ordered buckets in fewer than ${thresholds.minimumOrderedSeasons} seasons`,
            ]
          : []),
      ];
      return reasons;
    });
    const profilesPassing = profileCells.filter(
      (cell) =>
        cell.eligibleSamples >= thresholds.minimumSamplesPerCell &&
        cell.directionalSamples >= thresholds.minimumDirectionalSamplesPerCell &&
        (cell.rankCorrelation ?? -Infinity) >= thresholds.minimumRankCorrelation &&
        (cell.favorableMinusDifficult ?? -Infinity) >= thresholds.minimumBucketSpread &&
        cell.orderedSeasons >= thresholds.minimumOrderedSeasons,
    ).length;
    return {
      position,
      state:
        profileCells.length === input.profiles.length && failed.length === 0
          ? "validated"
          : "descriptive-only",
      samples: profileCells.reduce((sum, cell) => sum + cell.eligibleSamples, 0),
      directionalSamples: profileCells.reduce((sum, cell) => sum + cell.directionalSamples, 0),
      profilesPassing,
      profilesRequired: input.profiles.length,
      reasons: [...new Set(failed)].sort(),
    };
  });
  const evidence = stableEvidence(input, selected.id, cells, thresholds);
  return {
    version: SCHEDULE_EDGE_EVALUATION_VERSION,
    evidenceChecksum: createHash("sha256").update(evidence, "utf8").digest("hex"),
    heldOutSeasons: [...heldOut].sort((left, right) => left - right),
    selectedCandidateId: selected.id,
    selectedPolicy: selected.policy,
    observations: observations.filter((row) => row.candidateId === selected.id).length,
    cells,
    candidates: candidateSummaries,
    positionGates,
    leakagePolicy: {
      defenseInputs: "strictly-before-target-week",
      playerBaseline: "up-to-eight-games-strictly-before-target-week",
      targetOutcomeUse: "evaluation-only",
      futureSeasonUse: false,
    },
    thresholds,
  };
}
