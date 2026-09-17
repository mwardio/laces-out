import {
  evaluateFirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
} from "@laces-out/projections";
import { firstPartyRosAdmissionConstants } from "./first-party-ros-admission.js";
import { firstPartyRosChampionPolicyChecksum } from "./first-party-ros-publication.js";
import {
  FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS,
  FIRST_PARTY_ROS_RELEASE_MINIMUM_BATCHES,
  FIRST_PARTY_ROS_RELEASE_MINIMUM_FORECASTS,
  FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION,
} from "./first-party-ros-validation-contract.js";
export const constants = firstPartyRosAdmissionConstants();

function sourceAudit(season: number): Record<string, unknown> {
  return {
    season,
    weeklyStatsChecksum: "a".repeat(64),
    teamWeeklyStatsChecksum: "b".repeat(64),
    weeklyRosterChecksum: "c".repeat(64),
    injuryChecksum: "d".repeat(64),
    snapChecksum: "e".repeat(64),
    scheduleChecksum: "f".repeat(64),
  };
}

function heldOutForecast(
  season: number,
  asOfWeek: number,
  playerId: string,
  scoringProfileKey: string,
): FirstPartyRosHeldOutForecast {
  return {
    playerId,
    position: "WR",
    contextualModelVersion: "contextual-v1",
    recencyModelVersion: "recency-v1",
    scoringProfileKey,
    intervalMethodVersion: constants.intervalMethodVersion,
    forecastSeason: season,
    asOfWeek,
    windowStartWeek: asOfWeek + 1,
    windowEndWeek: 18,
    trainedThroughSeason: season - 1,
    inputChecksum: "1".repeat(64),
    evidence: {
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: 18 - asOfWeek,
        actualGames: 17 - asOfWeek,
        contextualExpectedGames: 17 - asOfWeek,
        recencyExpectedGames: 16.5 - asOfWeek,
      },
      convergence: {
        contextual: { state: "converged", diagnosticChecksum: "2".repeat(64) },
        recency: { state: "converged", diagnosticChecksum: "3".repeat(64) },
      },
    },
    contextual: { meanPoints: 101, p15Points: 86, p50Points: 101, p85Points: 116 },
    recency: { meanPoints: 108, p15Points: 83, p50Points: 108, p85Points: 133 },
    actualPoints: 100,
  };
}

function publicationPolicy(scoringProfileKey: string) {
  return evaluateFirstPartyRosChampionPolicy(
    [2023, 2024, 2025].map((season) => ({
      season,
      complete: true,
      forecasts: [
        heldOutForecast(season, 10, `${season}-one`, scoringProfileKey),
        heldOutForecast(season, 11, `${season}-two`, scoringProfileKey),
      ],
    })),
    {
      minimumHeldOutSeasons: 2,
      minimumBatches: 4,
      minimumSamples: 4,
      minimumCellSeasons: 2,
      minimumCellSamples: 4,
      minimumCellCutoffs: 2,
      minimumCellBatches: 4,
    },
  ).livePolicy;
}

export function validReport(overrides: {
  reportOverrides?: Record<string, unknown>;
  championOverrides?: Record<string, unknown>;
  evidenceIdentityOverrides?: Record<string, unknown>;
  sources?: unknown;
}): Record<string, unknown> {
  const scoringProfileKey =
    typeof overrides.evidenceIdentityOverrides?.scoringProfileKey === "string"
      ? overrides.evidenceIdentityOverrides.scoringProfileKey
      : constants.scoringProfileKey;
  const policy = publicationPolicy(scoringProfileKey);
  return {
    report: {
      state: "evidence-ready",
      blockers: [],
      seasons: [2022, 2023, 2024, 2025],
      playersPerPosition: FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION,
      maximumForecasts: FIRST_PARTY_ROS_RELEASE_MAXIMUM_FORECASTS,
      forecasts: FIRST_PARTY_ROS_RELEASE_MINIMUM_FORECASTS,
      batches: FIRST_PARTY_ROS_RELEASE_MINIMUM_BATCHES,
      availabilityCalibrationVersion: constants.availabilityCalibrationVersion,
      roleCalibrationVersion: constants.roleCalibrationVersion,
      kickerCalibrationVersion: constants.kickerCalibrationVersion,
      ...overrides.reportOverrides,
    },
    champion: {
      policyVersion: constants.policyVersion,
      modelVersion: constants.modelVersion,
      evidenceThroughSeason: 2025,
      globalBatches: 40,
      publicationPolicyChecksum: firstPartyRosChampionPolicyChecksum(policy),
      evidenceIdentity: {
        contextualModelVersion: "contextual-v1",
        recencyModelVersion: "recency-v1",
        scoringProfileKey: constants.scoringProfileKey,
        intervalMethodVersion: constants.intervalMethodVersion,
        ...overrides.evidenceIdentityOverrides,
      },
      choices: [],
      ...overrides.championOverrides,
    },
    publicationPolicy: policy,
    sources:
      overrides.sources === undefined
        ? [sourceAudit(2022), sourceAudit(2023), sourceAudit(2024), sourceAudit(2025)]
        : overrides.sources,
  };
}
