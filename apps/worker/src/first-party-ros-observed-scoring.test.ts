import { describe, expect, it, vi } from "vitest";
import {
  firstPartyTeamDefenseProjectionComponents,
  firstPartyProjectionComponentsForPosition,
  observedScoringComponentIssues,
  projectionScoringProfileKey,
  scoreProjectionStatComponents,
  type FirstPartyTeamDefenseWeeklyStatLine,
  type ProjectionScoringProfile,
  type ProjectionStatComponents,
} from "@laces-out/projections";
import {
  buildHistoricalRosBacktest,
  type HistoricalRosBacktestInput,
  type HistoricalRosPreparation,
  type HistoricalRosProjectionEvaluator,
} from "./first-party-ros-backtest.js";
import type { ProjectionScheduleFact } from "./first-party-projection-inputs.js";
import { ROS_HISTORICAL_COVERAGE_DEFAULT_THRESHOLDS } from "./ros-data-coverage.js";

const defenseStats = firstPartyTeamDefenseProjectionComponents();
const profile: ProjectionScoringProfile = {
  id: "observed-defense-counts",
  rules: [
    { statId: "defensive_two_point_returns", points: 2 },
    { statId: "one_point_safeties", points: 0, bonuses: [{ atLeast: 1, points: 0 }] },
    { statId: "passing_yards", points: 0.04 },
  ],
};

describe("observed scoring component completeness", () => {
  it("requires observed zero, ignoring offense rules and rules with no scoring effect", () => {
    expect(
      observedScoringComponentIssues({ components: {}, profile, applicableStatIds: defenseStats }),
    ).toEqual({ missingComponents: ["defensive_two_point_returns"], invalidComponents: [] });
    expect(
      observedScoringComponentIssues({
        components: { defensive_two_point_returns: 0 },
        profile,
        applicableStatIds: defenseStats,
      }),
    ).toEqual({ missingComponents: [], invalidComponents: [] });
    // The ordinary forecast scorer intentionally retains its existing behavior.
    expect(scoreProjectionStatComponents({}, profile)).toBe(0);
  });

  it("requires a component priced only through a nonzero bonus", () => {
    const bonusOnly: ProjectionScoringProfile = {
      id: "bonus-only-observed-count",
      rules: [{ statId: "one_point_safeties", points: 0, bonuses: [{ atLeast: 1, points: 5 }] }],
    };
    expect(
      observedScoringComponentIssues({
        components: {},
        profile: bonusOnly,
        applicableStatIds: defenseStats,
      }),
    ).toEqual({ missingComponents: ["one_point_safeties"], invalidComponents: [] });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5])(
    "rejects invalid observed rare-event count %s",
    (value) => {
      expect(
        observedScoringComponentIssues({
          components: { defensive_two_point_returns: value },
          profile,
          applicableStatIds: defenseStats,
        }),
      ).toEqual({ missingComponents: [], invalidComponents: ["defensive_two_point_returns"] });
    },
  );

  it("does not accept an inherited property as an observed component", () => {
    expect(
      observedScoringComponentIssues({
        components: Object.create({ defensive_two_point_returns: 0 }) as ProjectionStatComponents,
        profile,
        applicableStatIds: defenseStats,
      }),
    ).toEqual({ missingComponents: ["defensive_two_point_returns"], invalidComponents: [] });
  });

  it("accepts finite negative observed yardage but rejects nonfinite required yardage", () => {
    for (const value of [-12, Number.NEGATIVE_INFINITY]) {
      expect(
        observedScoringComponentIssues({
          components: { passing_yards: value },
          profile,
          applicableStatIds: ["passing_yards"],
        }),
      ).toEqual({
        missingComponents: [],
        invalidComponents: Number.isFinite(value) ? [] : ["passing_yards"],
      });
    }
  });
});

function fixture(missingFinalWeek: boolean): HistoricalRosBacktestInput {
  const defenseHistory: FirstPartyTeamDefenseWeeklyStatLine[] = [];
  const schedules: ProjectionScheduleFact[] = [];
  for (const season of [2019, 2020, 2021, 2022, 2023, 2024]) {
    for (let week = 1; week <= 18; week += 1) {
      defenseHistory.push({
        team: "LAR",
        opponent: "SEA",
        season,
        week,
        played: true,
        components: {
          defensive_sacks: 2 + (week % 3),
          defensive_interceptions: week % 2,
          defensive_fumble_recoveries: (week + 1) % 2,
          defensive_safeties: 0,
          defensive_touchdowns: 0,
          defensive_blocked_kicks: 0,
          fourth_down_stops: 1,
          special_teams_touchdowns: 0,
          points_allowed: 17 + (week % 10),
          yards_allowed: 290 + week * 3,
          ...(missingFinalWeek && season === 2022 && week === 18
            ? {}
            : { defensive_two_point_returns: week === 17 ? 1 : 0 }),
        },
      });
      schedules.push({
        season,
        week,
        gameId: `${season}:${week}:LAR:SEA`,
        awayTeam: "LAR",
        homeTeam: "SEA",
        awayScore: 20,
        homeScore: 17,
        kickoffAt: new Date(Date.UTC(season, 8, week)),
      });
    }
  }
  return {
    history: [],
    defenseHistory,
    rosters: [],
    injuries: [],
    schedules,
    scoringProfile: profile,
    options: {
      heldOutSeasons: [2022, 2023, 2024],
      asOfWeeks: [16],
      positions: ["DST"],
      playersPerPosition: 1,
    },
    coverage: {
      state: "qualified",
      thresholds: ROS_HISTORICAL_COVERAGE_DEFAULT_THRESHOLDS,
      heldOutSeasonsRequested: [2022, 2023, 2024],
      fullyHeldOutSeasons: [2022, 2023, 2024],
      completeAsOfBatches: 3,
      totalAsOfBatches: 3,
      reasons: [],
      seasons: [2022, 2023, 2024].map((season) => ({
        season,
        priorSeasons: [2019, 2020, 2021],
        priorSeasonCoverage: [],
        expectedWeeks: [17, 18],
        eligibleAsOfWeeks: 1,
        completeAsOfWeeks: 1,
        fullyHeldOut: true,
        reasons: [],
        weeks: [
          {
            targetWeek: 17,
            asOfWeek: 16,
            scheduleGames: 1,
            completedScheduleGames: 1,
            injuryBatchRows: 0,
            positions: [],
            complete: true,
            reasons: [],
          },
        ],
      })),
    },
  };
}

describe("historical ROS observed-week scoring boundary", () => {
  it("cannot hide a missing second-week observation behind a first-week value", async () => {
    const projectionEvaluator = vi.fn(async () => {
      throw new Error("must not simulate incomplete outcomes");
    });
    await expect(
      buildHistoricalRosBacktest({ ...fixture(true), projectionEvaluator }),
    ).rejects.toThrow(
      "Historical ROS actual components unavailable at 2022:18; missing=defensive_two_point_returns",
    );
    expect(projectionEvaluator).not.toHaveBeenCalled();
  });

  it("admits explicitly observed zeros without requiring unrelated offense or zero-only rules", async () => {
    const stop = new Error("complete input captured without simulation or qualification");
    const projectionEvaluator = vi.fn(async () => {
      throw stop;
    });
    await expect(
      buildHistoricalRosBacktest({ ...fixture(false), projectionEvaluator }),
    ).rejects.toBe(stop);
    expect(projectionEvaluator).toHaveBeenCalledTimes(2);
  });

  const fakeProjection: HistoricalRosProjectionEvaluator = async (input) => ({
    expectedGames: 2,
    meanPoints: 1,
    p15Points: 0,
    p50Points: 1,
    p85Points: 2,
    scenarioCount: 1,
    seedHash: "0".repeat(64),
    scoringProfileKey: projectionScoringProfileKey(input.scoringProfile),
  });

  it.each(["missing", "invalid"] as const)(
    "omits %s unpriced weekly components from reusable outcome aggregates",
    async (condition) => {
      const input = fixture(condition === "missing");
      const stop = new Error("captured synthetic actual aggregates; no convergence or grading");
      let prepared: HistoricalRosPreparation | undefined;
      await expect(
        buildHistoricalRosBacktest({
          ...input,
          defenseHistory: input.defenseHistory.map((row) =>
            condition === "invalid" && row.season === 2022 && row.week >= 17
              ? { ...row, components: { ...row.components, defensive_two_point_returns: 0.5 } }
              : row,
          ),
          scoringProfile: { id: "sacks-only", rules: [{ statId: "defensive_sacks", points: 1 }] },
          projectionEvaluator: fakeProjection,
          onPrepared: (value) => {
            prepared = value;
            throw stop;
          },
        }),
      ).rejects.toBe(stop);
      const actual = prepared!.drafts.find((draft) => draft.forecast.forecastSeason === 2022)!;
      expect(actual.forecast.actualPoints).toBe(6);
      expect(actual.actualComponents.defensive_sacks).toBe(6);
      expect(Object.hasOwn(actual.actualComponents, "defensive_two_point_returns")).toBe(false);
    },
  );

  it("does not exempt a receiver's missing passing observation based on roster position", async () => {
    const input = fixture(false);
    const playerStats = Object.fromEntries(
      ["QB", "RB", "WR", "TE", "K"]
        .flatMap(firstPartyProjectionComponentsForPosition)
        .map((name) => [name, 0]),
    );
    const history = input.defenseHistory.map((row) => {
      const components: Record<string, number> = {
        ...playerStats,
        receptions: 5,
        receiving_yards: 50,
        targets: 8,
      };
      if (row.season === 2022 && row.week === 18) delete components.passing_yards;
      return { ...row, playerId: "fixture-receiver", position: "WR", components, snapShare: 0.8 };
    });
    await expect(
      buildHistoricalRosBacktest({
        ...input,
        history,
        defenseHistory: [],
        rosters: history.map((row) => ({
          playerId: row.playerId,
          position: row.position,
          team: row.team,
          season: row.season,
          week: row.week,
        })),
        options: { ...input.options, positions: ["WR"] },
        scoringProfile: { id: "passing-only", rules: [{ statId: "passing_yards", points: 0.04 }] },
        projectionEvaluator: fakeProjection,
      }),
    ).rejects.toThrow(
      "Historical ROS actual components unavailable at 2022:18; missing=passing_yards",
    );
  });
});
