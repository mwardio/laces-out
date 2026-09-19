import { createHash } from "node:crypto";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
  type FirstPartyRosProjectionInput,
} from "@laces-out/projections";
import {
  ROS_HISTORICAL_CORPUS_SCHEMA_VERSION,
  ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION,
  type RosHistoricalCorpus,
} from "./ros-historical-corpus.js";
import {
  ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
  ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS,
  ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
} from "./ros-historical-corpus-protocol.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function historicalCorpusFixture(): RosHistoricalCorpus {
  const checksums = Object.fromEntries(
    [
      "weeklyStatsChecksum",
      "teamWeeklyStatsChecksum",
      "weeklyRosterChecksum",
      "injuryChecksum",
      "snapChecksum",
      "scheduleChecksum",
    ].map((name) => [name, hash(name)]),
  );
  return {
    schemaVersion: ROS_HISTORICAL_CORPUS_SCHEMA_VERSION,
    actualDefinitionVersion: ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION,
    buildProtocol: ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    outcomeSchemaVersion: FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
    weeklyModelVersion: ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.weeklyModelVersion,
    productionBasis: ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.productionBasis,
    sourceChecksums: { ...checksums, catalog: hash("catalog") },
    sourceAudit: [{ season: 2025, ...checksums, unresolvedSnapRows: 0 }],
    coverage: {
      state: "qualified",
      thresholds: ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS,
      heldOutSeasonsRequested: [2025],
      fullyHeldOutSeasons: [2025],
      completeAsOfBatches: 1,
      totalAsOfBatches: 1,
      reasons: [],
      seasons: [
        {
          season: 2025,
          priorSeasons: [2024],
          priorSeasonCoverage: [
            {
              season: 2024,
              weeklyStatRows: 100,
              weeklyRosterRows: 100,
              injuryRows: 100,
              snapRows: 100,
              scheduleGames: 272,
              completedScheduleGames: 272,
              complete: true,
              missingDatasets: [],
            },
          ],
          expectedWeeks: [5],
          eligibleAsOfWeeks: 1,
          completeAsOfWeeks: 1,
          fullyHeldOut: true,
          reasons: [],
          weeks: [
            {
              targetWeek: 5,
              asOfWeek: 4,
              scheduleGames: 16,
              completedScheduleGames: 16,
              injuryBatchRows: 100,
              complete: true,
              reasons: [],
              positions: [
                {
                  position: "WR",
                  outcomePlayers: 10,
                  priorStatPlayers: 10,
                  priorRosterPlayers: 10,
                  priorSnapPlayers: 10,
                  priorInjuryReports: 10,
                  rosterMatches: 10,
                  snapMatches: 10,
                  rosterMatchRate: 1,
                  snapMatchRate: 1,
                  missingRosterPlayerIds: [],
                  missingSnapPlayerIds: [],
                  complete: true,
                  reasons: [],
                },
              ],
            },
          ],
        },
      ],
    },
    options: {
      heldOutSeasons: [2025],
      asOfWeeks: [4],
      positions: ["WR"],
      playersPerPosition: 8,
      maximumForecasts: 6_000,
      ...ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
    },
    seasons: [2025],
    skippedForecasts: 0,
    kickerFamilyAudit: [],
    forecasts: [
      {
        forecast: {
          playerId: "receiver",
          position: "WR",
          contextualModelVersion: `${FIRST_PARTY_ROS_MODEL_VERSION}:contextual:${ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.weeklyComponentModelVersion}`,
          recencyModelVersion: `${FIRST_PARTY_ROS_MODEL_VERSION}:availability-aware-recency:${ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.weeklyComponentModelVersion}`,
          intervalMethodVersion: ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.intervalMethodVersion,
          forecastSeason: 2025,
          asOfWeek: 4,
          windowStartWeek: 5,
          windowEndWeek: 18,
          trainedThroughSeason: 2024,
          inputChecksum: hash("football input"),
        },
        contextualKey: {
          modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
          identity: hash("contextual"),
        },
        recencyKey: { modelVersion: FIRST_PARTY_ROS_MODEL_VERSION, identity: hash("recency") },
        actualComponents: { receiving_yards: -3.5, receptions: 1, receiving_touchdowns: 0 },
        coverage: { contextual: 1, recency: 0.98 },
        actualGames: 1,
        scheduledGames: 13,
      },
    ],
  };
}

export function historicalOutcomeInputFixture(
  overrides: Partial<FirstPartyRosProjectionInput> = {},
): FirstPartyRosProjectionInput {
  return {
    playerId: "receiver",
    position: "WR",
    season: 2026,
    asOfWeek: 4,
    asOfAt: "2026-10-01T12:00:00.000Z",
    windowStartWeek: 5,
    windowEndWeek: 5,
    strategy: "contextual",
    weeks: [
      {
        season: 2026,
        week: 5,
        scheduled: true,
        bye: false,
        contextualComponents: { receptions: 6, receiving_yards: 80, receiving_touchdowns: 0.4 },
        recencyComponents: { receptions: 5, receiving_yards: 70, receiving_touchdowns: 0.3 },
        componentElasticities: {
          receptions: { role: 1, production: 1 },
          receiving_yards: { role: 1, production: 1 },
          receiving_touchdowns: { role: 0.7, production: 1.2 },
        },
      },
    ],
    availability: {
      state: "active",
      newAbsenceProbability: 0.1,
      recoveryProbability: 0.25,
      reserveRecoveryProbability: 0.1,
      limitedRoleMultiplier: 0.8,
      returnRoleMultiplier: 0.82,
    },
    role: {
      currentMultiplier: 1,
      persistence: 0.82,
      innovationVolatility: 0.1,
      weeklyProductionVolatility: 0.3,
      centerVolatility: 0.15,
      minimumMultiplier: 0.2,
      maximumMultiplier: 3,
    },
    inputChecksum: "a".repeat(64),
    weeklyModelVersion: ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL.weeklyModelVersion,
    seed: "football-only",
    scoringProfile: {
      id: "ppr",
      rules: [
        { statId: "receptions", points: 1 },
        { statId: "receiving_yards", points: 0.1 },
        { statId: "receiving_touchdowns", points: 6 },
      ],
    },
    ...overrides,
  };
}
