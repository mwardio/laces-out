import { describe, expect, it } from "vitest";
import {
  SCORING_LONG_TOUCHDOWN_COMPONENTS,
  type FirstPartyWeeklyStatLine,
} from "@laces-out/projections";
import {
  HISTORICAL_ROS_SCORING_PROFILE,
  preflightHistoricalRosComponentCoverage,
} from "./first-party-ros-backtest.js";
import {
  ROS_HISTORICAL_COVERAGE_DEFAULT_THRESHOLDS,
  type RosHistoricalCoverageReport,
} from "./ros-data-coverage.js";

const coverage: RosHistoricalCoverageReport = {
  state: "qualified",
  thresholds: ROS_HISTORICAL_COVERAGE_DEFAULT_THRESHOLDS,
  heldOutSeasonsRequested: [2024],
  fullyHeldOutSeasons: [2024],
  completeAsOfBatches: 2,
  totalAsOfBatches: 2,
  reasons: [],
  seasons: [
    {
      season: 2024,
      priorSeasons: [2021, 2022, 2023],
      priorSeasonCoverage: [],
      expectedWeeks: [10, 11],
      eligibleAsOfWeeks: 2,
      completeAsOfWeeks: 2,
      fullyHeldOut: true,
      reasons: [],
      weeks: [9, 10].map((asOfWeek) => ({
        targetWeek: asOfWeek + 1,
        asOfWeek,
        scheduleGames: 1,
        completedScheduleGames: 1,
        injuryBatchRows: 1,
        positions: [],
        complete: true,
        reasons: [],
      })),
    },
  ],
};
const complete = Object.fromEntries(
  SCORING_LONG_TOUCHDOWN_COMPONENTS.flatMap(({ total, fortyPlus, fiftyPlus }) => [
    [total, 0],
    [fortyPlus, 0],
    [fiftyPlus, 0],
  ]),
);
function input(corrected: boolean) {
  const history: FirstPartyWeeklyStatLine[] = ["a", "b"].flatMap((playerId) => [
    {
      playerId,
      season: 2022,
      week: 3,
      position: "QB",
      team: "ATL",
      played: true,
      components: corrected
        ? complete
        : {
            passing_touchdowns: 0,
            passing_touchdowns_40_plus: 0,
            passing_touchdowns_50_plus: 0,
            rushing_touchdowns: 0,
            rushing_touchdowns_40_plus: 0,
            rushing_touchdowns_50_plus: 0,
          },
    },
    {
      playerId,
      season: 2024,
      week: 9,
      position: "TE",
      team: "ATL",
      played: true,
      components: { ...complete, receptions: 1 },
    },
  ]);
  return {
    history,
    coverage,
    scoringProfile: HISTORICAL_ROS_SCORING_PROFILE,
    rosters: ["a", "b"].map((playerId) => ({
      playerId,
      season: 2024,
      week: 9,
      position: "TE",
      team: "ATL",
      status: "IR",
    })),
    schedules: [
      {
        season: 2024,
        week: 11,
        gameId: "2024_11_ATL_NO",
        homeTeam: "ATL",
        awayTeam: "NO",
        homeScore: 20,
        awayScore: 10,
      },
    ],
    options: { heldOutSeasons: [2022, 2023, 2024], asOfWeeks: [9, 10], playersPerPosition: 8 },
  };
}

describe("historical ROS component preflight", () => {
  it("blocks incomplete future actuals before model work without using them as features", () => {
    const source = input(true);
    const result = preflightHistoricalRosComponentCoverage({
      ...source,
      playerActualHistory: [
        ...source.history,
        {
          playerId: "a",
          season: 2024,
          week: 11,
          position: "TE",
          team: "ATL",
          played: true,
          components: { receptions: 0 },
        },
      ],
    });
    expect(result.state).toBe("blocked");
    expect(result.failures).toEqual([]);
    expect(result.actualFailures).toHaveLength(2);
    expect(result.actualFailures.every((failure) => failure.playerId === "a")).toBe(true);
    expect(result.actualFailures[0]?.reason).toMatch(/actual components unavailable/);
    expect(
      preflightHistoricalRosComponentCoverage({
        ...source,
        playerActualHistory: [
          {
            playerId: "a",
            season: 2024,
            week: 11,
            position: "TE",
            team: "ATL",
            played: false,
            components: {},
          },
        ],
      }).state,
    ).toBe("qualified");
  });

  it("reports every failing selected window before any calibration or draws, including currently inactive players", () => {
    const result = preflightHistoricalRosComponentCoverage(input(false));
    expect(result.state).toBe("blocked");
    expect(result.checkedBatches).toBe(2);
    expect(result.checkedPlayers).toBe(4);
    expect(result.checkedScheduledWeeks).toBe(4);
    expect(result.failures.map(({ asOfWeek, playerId }) => `${asOfWeek}:${playerId}`)).toEqual([
      "9:a",
      "9:b",
      "10:a",
      "10:b",
    ]);
    for (const failure of result.failures) {
      expect(failure.firstScheduledWeek).toBe(11);
      expect(failure.contextualMissing).toEqual([
        "receiving_touchdowns_40_plus",
        "receiving_touchdowns_50_plus",
      ]);
      expect(failure.recencyMissing).toEqual([]);
    }
  });

  it("qualifies corrected evidence and respects requested cutoff and position scopes", () => {
    expect(preflightHistoricalRosComponentCoverage(input(true))).toMatchObject({
      state: "qualified",
      failures: [],
      checkedPlayers: 4,
    });
    const source = input(false);
    expect(
      preflightHistoricalRosComponentCoverage({
        ...source,
        options: { ...source.options, asOfWeeks: [10] },
      }).failures,
    ).toHaveLength(2);
    expect(
      preflightHistoricalRosComponentCoverage({
        ...source,
        options: { ...source.options, positions: ["QB"] },
      }),
    ).toMatchObject({ state: "qualified", checkedPlayers: 0 });
  });

  it("does not allow a later observation to fill evidence missing at an earlier cutoff", () => {
    const source = input(true);
    const history = source.history.map((row) =>
      row.season === 2024 ? { ...row, components: { receptions: 1 } } : row,
    );
    expect(
      preflightHistoricalRosComponentCoverage({
        ...source,
        history: [
          ...history,
          ...source.history
            .filter((row) => row.season === 2024)
            .map((row) => ({ ...row, week: 11 })),
        ],
      }).state,
    ).toBe("blocked");
  });
});
