import { createHash } from "node:crypto";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  evaluateFirstPartyRosChampionPolicy,
  rosProfileDefinitionFromKey,
  rosScoringProfile,
  type FirstPartyRosChampionOptions,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosPosition,
  type FirstPartyRosRemainingWeeksBucket,
  type FirstPartyRosStrategy,
} from "@laces-out/projections";
import { firstPartyRosChampionPolicyChecksum } from "./first-party-ros-publication.js";
import { ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION } from "./ros-historical-corpus.js";

export const SEASONS = [2022, 2023, 2024, 2025];
export const TEAMS = ["LAR", "BUF", "KC", "SF", "DAL", "BAL", "PIT", "MIA"];
export const BUCKETS: readonly FirstPartyRosRemainingWeeksBucket[] = [
  "one-to-four",
  "five-to-eight",
  "nine-plus",
];
export const STRATEGIES: readonly FirstPartyRosStrategy[] = [
  "contextual",
  "availability-aware-recency",
];
export const OPTIONS: FirstPartyRosChampionOptions = {
  minimumHeldOutSeasons: 3,
  minimumBatches: 30,
  minimumSamples: 300,
  minimumCellSeasons: 3,
  minimumCellSamples: 18,
  minimumCellCutoffs: 3,
  minimumCellBatches: 9,
  minimumModelImprovement: 0.01,
};
export const SCORING = rosProfileDefinitionFromKey(rosScoringProfile("full-ppr").scoringProfileKey);
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const rowBucket = (row: FirstPartyRosHeldOutForecast): FirstPartyRosRemainingWeeksBucket => {
  const weeks = row.windowEndWeek - row.windowStartWeek + 1;
  return weeks <= 4 ? "one-to-four" : weeks <= 8 ? "five-to-eight" : "nine-plus";
};

export function forecasts(
  previous: boolean,
  teams: readonly string[] = TEAMS,
): FirstPartyRosHeldOutForecast[] {
  const model = previous ? "laces-ros-distribution-v12" : FIRST_PARTY_ROS_MODEL_VERSION;
  return SEASONS.flatMap((season) =>
    Array.from({ length: 17 }, (_, cutoffIndex) => cutoffIndex + 1).flatMap((cutoff) =>
      teams.map((team): FirstPartyRosHeldOutForecast => {
        const games = 18 - cutoff;
        const playerId = `DST:${previous && team === "LAR" ? "LA" : team}`;
        const candidate = {
          meanPoints: 2 * games + 1,
          p15Points: games,
          p50Points: 2 * games,
          p85Points: 3 * games,
        };
        return {
          playerId,
          position: "DST",
          forecastSeason: season,
          asOfWeek: cutoff,
          windowStartWeek: cutoff + 1,
          windowEndWeek: 18,
          trainedThroughSeason: season - 1,
          inputChecksum: hash(`${model}:${season}:${cutoff}:${playerId}`),
          contextualModelVersion: `${model}:contextual:laces-weekly-components-v15`,
          recencyModelVersion: `${model}:availability-aware-recency:laces-weekly-components-v15`,
          scoringProfileKey: SCORING.scoringProfileKey,
          intervalMethodVersion: "simulation-p15-p50-p85-cqr-v1",
          evidence: {
            coverage: { contextual: 1, recency: 1 },
            availability: {
              scheduledGames: games,
              actualGames: games,
              contextualExpectedGames: games,
              recencyExpectedGames: games,
            },
            convergence: {
              contextual: {
                state: "converged",
                diagnosticChecksum: hash(`${model}:${season}:${cutoff}:${playerId}:contextual`),
              },
              recency: {
                state: "converged",
                diagnosticChecksum: hash(`${model}:${season}:${cutoff}:${playerId}:recency`),
              },
            },
          },
          contextual: { ...candidate },
          recency: { ...candidate },
          actualPoints: 2 * games,
        };
      }),
    ),
  );
}

interface ConvergenceFixture {
  season: number;
  position: FirstPartyRosPosition;
  bucket: FirstPartyRosRemainingWeeksBucket;
  strategy: FirstPartyRosStrategy;
  state: "converged" | "unstable";
  worstToleranceRatio: number;
}

/** Recompute every policy/identity/selection proof after raw mutations, as the actual CLI does. */
export function reportFixture(
  previous: boolean,
  raw = forecasts(previous),
  positions: readonly FirstPartyRosPosition[] = ["DST"],
) {
  const modelVersion = previous ? "laces-ros-distribution-v12" : FIRST_PARTY_ROS_MODEL_VERSION;
  const legacy = evaluateFirstPartyRosChampionPolicy(
    SEASONS.map((season) => ({
      season,
      complete: true,
      forecasts: raw.filter((row) => row.forecastSeason === season),
    })),
    OPTIONS,
  );
  const publicationPolicy = { ...legacy.livePolicy, modelVersion } as FirstPartyRosChampionPolicy;
  const convergenceAudit = SEASONS.flatMap((season) =>
    positions.flatMap((position) =>
      BUCKETS.flatMap((bucket) =>
        STRATEGIES.map((strategy): ConvergenceFixture => {
          const candidate = strategy === "contextual" ? "contextual" : "recency";
          const unstable = raw.some(
            (row) =>
              row.forecastSeason === season &&
              row.position === position &&
              rowBucket(row) === bucket &&
              row.evidence.convergence[candidate].state === "unstable",
          );
          return {
            season,
            position,
            bucket,
            strategy,
            state: unstable ? "unstable" : "converged",
            worstToleranceRatio: unstable ? 2 : 0.5,
          };
        }),
      ),
    ),
  );
  return {
    validationMode: "read-only-first-party-ros-backtest",
    validationScope: { positions: [...positions], completePortfolio: positions.length === 6 },
    noDatabaseWrites: true,
    sourcePolicy: "official-nflverse-artifacts",
    outcomeCorpusIdentity: hash(`${modelVersion}:complete-corpus`),
    actualDefinitionVersion: ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION,
    scoringProfile: { key: SCORING.key, label: SCORING.label, digest: SCORING.digest },
    coverage: {
      state: "qualified",
      fullyHeldOutSeasons: [...SEASONS],
      completeAsOfBatches: 68,
      totalAsOfBatches: 68,
    },
    report: {
      state: "evidence-ready",
      blockers: [] as string[],
      seasons: [...SEASONS],
      playersPerPosition: 8,
      maximumForecasts: 6000,
      forecasts: raw.length,
      batches: 68,
      skippedForecasts: 0,
      diagnosedPairs: 12 * positions.length,
      convergenceAudit,
      leakagePolicy: {
        calibration: "seasons-strictly-before-heldout",
        features: "strictly-before-cutoff",
        futureRosterUse: false,
        targetOutcomeUse: "evaluation-only",
      },
    },
    champion: { publicationPolicyChecksum: firstPartyRosChampionPolicyChecksum(publicationPolicy) },
    publicationPolicy,
    diagnostics: {
      candidateForecasts: raw,
      selected: legacy.selected,
      seasonPolicies: legacy.seasonPolicies.map((audit) => ({
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
    },
    identityAudit: {
      inputChecksums: new Set(raw.map((row) => row.inputChecksum)).size,
      contextualConvergenceChecksums: new Set(
        raw.map((row) => row.evidence.convergence.contextual.diagnosticChecksum),
      ).size,
      recencyConvergenceChecksums: new Set(
        raw.map((row) => row.evidence.convergence.recency.diagnosticChecksum),
      ).size,
      ...legacy.livePolicy.evidenceIdentity!,
    },
    sources: [2019, 2020, 2021, 2022, 2023, 2024, 2025].map((season) => ({
      season,
      weeklyStatsChecksum: hash(`${season}:weekly-stats`),
      playerWeeklyRawChecksum: hash(`${season}:raw-player-weekly`),
      playerTouchdownPlayByPlayChecksum: hash(`${season}:touchdown-pbp`),
      teamWeeklyStatsChecksum: hash(`${season}:team-weekly`),
      weeklyRosterChecksum: hash(`${season}:weekly-roster`),
      injuryChecksum: hash(`${season}:injury`),
      snapChecksum: hash(`${season}:snaps`),
      scheduleChecksum: hash(`${season}:schedule`),
    })),
  };
}
