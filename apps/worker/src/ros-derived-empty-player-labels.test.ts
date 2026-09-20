import { expect, it } from "vitest";
import { observedScoringComponentIssues } from "@laces-out/projections";
import { completeVerifiedEmptyRosPlayerLabels } from "./ros-derived-empty-player-labels.js";
import { historicalCorpusFixture } from "./ros-historical-outcome.test-fixtures.js";

function fixture() {
  const base = historicalCorpusFixture();
  const forecasts = [
    {
      ...base.forecasts[0]!,
      forecast: {
        ...base.forecasts[0]!.forecast,
        forecastSeason: 2025,
        playerId: "00-0036168",
        windowStartWeek: 18,
        windowEndWeek: 18,
      },
      actualComponents: {},
      actualGames: 0,
      scheduledGames: 1,
    },
  ];
  const corpus = {
    sourceAudit: [{ season: 2025, playerWeeklyRawChecksum: "b".repeat(64) }],
    coverage: {
      ...base.coverage,
      seasons: [
        {
          ...base.coverage.seasons[0]!,
          season: 2025,
          weeks: [
            {
              ...base.coverage.seasons[0]!.weeks[0]!,
              targetWeek: 18,
              complete: true,
              scheduleGames: 1,
              completedScheduleGames: 1,
            },
          ],
        },
      ],
    },
  } as unknown as typeof base;
  const certification = {
    normalizedInputs: [
      { name: "history", exactMatch: true, oldSha256: "a".repeat(64), newSha256: "a".repeat(64) },
    ],
  };
  const zeroEvidence = {
    version: "complete-player-ledger-actuals-v1",
    originalForecastHistorySha256: "a".repeat(64),
    zeroObservations: [],
    ledgers: [
      {
        version: "nflverse-player-zero-ledger-v1",
        season: 2025,
        sourceChecksum: "b".repeat(64),
        state: "complete",
        unknownPlayerProductionRows: 0,
        playerWeeks: [] as string[],
        games: [
          { season: 2025, week: 18, gameId: "2025_18_ATL_TB", team: "ATL", opponentTeam: "TB" },
          { season: 2025, week: 18, gameId: "2025_18_ATL_TB", team: "TB", opponentTeam: "ATL" },
        ],
      },
    ],
  };
  const actualVerification = {
    state: "current-actuals-recomputed",
    actualDefinitionVersion: "complete-player-ledger-actuals-v1",
    currentHistorySha256: "a".repeat(64),
    requested: 1,
    completed: 1,
    errors: [],
    certifiedZeroObservations: 0,
  };
  return { forecasts, corpus, certification, zeroEvidence, actualVerification };
}

it("completes only ledger-certified empty windows without modifying physical forecast identity", () => {
  const input = fixture();
  const output = completeVerifiedEmptyRosPlayerLabels(input);
  expect(output[0]!.forecast).toBe(input.forecasts[0]!.forecast);
  expect(output[0]!.contextualKey).toBe(input.forecasts[0]!.contextualKey);
  expect(input.forecasts[0]!.actualComponents).toEqual({});
  expect(output[0]!.actualComponents.receptions).toBe(0);
  expect(output[0]!.actualComponents.field_goals_made_50_plus).toBe(0);
  expect(output[0]!.actualGames).toBe(0);
});

it("does not fill individual missing stats in a nonempty observed line", () => {
  const input = fixture();
  input.forecasts[0]!.actualComponents = { receptions: 0 };
  const output = completeVerifiedEmptyRosPlayerLabels(input);
  expect(output[0]).toBe(input.forecasts[0]);
  expect(
    observedScoringComponentIssues({
      components: output[0]!.actualComponents,
      profile: { id: "actual", rules: [{ statId: "receiving_yards", points: 0.1 }] },
      applicableStatIds: ["receiving_yards"],
    }).missingComponents,
  ).toEqual(["receiving_yards"]);
});

it.each([
  [
    "player observation",
    (input: ReturnType<typeof fixture>) => {
      input.zeroEvidence.ledgers[0]!.playerWeeks.push("2025:18:00-0036168");
    },
  ],
  [
    "incomplete ledger",
    (input: ReturnType<typeof fixture>) => {
      input.zeroEvidence.ledgers[0]!.state = "incomplete";
    },
  ],
  [
    "unknown production",
    (input: ReturnType<typeof fixture>) => {
      input.zeroEvidence.ledgers[0]!.unknownPlayerProductionRows = 1;
    },
  ],
  [
    "different source",
    (input: ReturnType<typeof fixture>) => {
      input.zeroEvidence.ledgers[0]!.sourceChecksum = "c".repeat(64);
    },
  ],
  [
    "different history",
    (input: ReturnType<typeof fixture>) => {
      input.zeroEvidence.originalForecastHistorySha256 = "c".repeat(64);
    },
  ],
  [
    "missing team",
    (input: ReturnType<typeof fixture>) => {
      input.zeroEvidence.ledgers[0]!.games.pop();
    },
  ],
  [
    "missing game",
    (input: ReturnType<typeof fixture>) => {
      input.zeroEvidence.ledgers[0]!.games = [];
    },
  ],
  [
    "duplicate game",
    (input: ReturnType<typeof fixture>) => {
      input.zeroEvidence.ledgers[0]!.games.push(input.zeroEvidence.ledgers[0]!.games[0]!);
    },
  ],
  [
    "uncovered week",
    (input: ReturnType<typeof fixture>) => {
      input.forecasts[0]!.forecast.windowStartWeek = 17;
    },
  ],
  [
    "contradictory appearance",
    (input: ReturnType<typeof fixture>) => {
      input.forecasts[0]!.actualGames = 1;
    },
  ],
  [
    "unverified actual population",
    (input: ReturnType<typeof fixture>) => {
      input.actualVerification.completed = 0;
    },
  ],
] as const)("rejects %s before filling any missing labels", (_name, mutate) => {
  const input = fixture();
  mutate(input);
  expect(() => completeVerifiedEmptyRosPlayerLabels(input)).toThrow();
});
