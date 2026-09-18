import { describe, expect, it, vi } from "vitest";
import type {
  FirstPartyRosProjectionInput,
  FirstPartyTeamDefenseWeeklyStatLine,
} from "@laces-out/projections";
import {
  buildHistoricalRosBacktest,
  HISTORICAL_ROS_DEFENSE_INPUT_VERSION,
  HISTORICAL_ROS_DEFENSE_SCHEDULE_VERSION,
  HISTORICAL_ROS_SCORING_PROFILE,
  prepareHistoricalRosDefenseSchedule,
  selectHistoricalRosDefenses,
  type HistoricalRosBacktestInput,
} from "./first-party-ros-backtest.js";
import type { ProjectionScheduleFact } from "./first-party-projection-inputs.js";
import { ROS_HISTORICAL_COVERAGE_DEFAULT_THRESHOLDS } from "./ros-data-coverage.js";

function game(season = 2022, week = 1, awayTeam = "LA", homeTeam = "SEA"): ProjectionScheduleFact {
  return {
    season,
    week,
    gameId: `${season}:${week}:${awayTeam}:${homeTeam}`,
    awayTeam,
    homeTeam,
    awayScore: 20,
    homeScore: 17,
    kickoffAt: new Date(Date.UTC(season, 8, week)),
  };
}

function outcome(
  season = 2022,
  week = 1,
  team = "LAR",
  opponent = "SEA",
): FirstPartyTeamDefenseWeeklyStatLine {
  return {
    season,
    week,
    team,
    opponent,
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
    },
  };
}

function fixture(): HistoricalRosBacktestInput {
  const defenseHistory: FirstPartyTeamDefenseWeeklyStatLine[] = [];
  const schedules: ProjectionScheduleFact[] = [];
  for (const season of [2019, 2020, 2021, 2022, 2023, 2024]) {
    for (let week = 1; week <= 18; week += 1) {
      if (week === 6) continue;
      defenseHistory.push(outcome(season, week));
      schedules.push(game(season, week));
    }
  }
  return {
    history: [],
    defenseHistory,
    rosters: [],
    injuries: [],
    schedules,
    scoringProfile: HISTORICAL_ROS_SCORING_PROFILE,
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
        expectedWeeks: [17],
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

describe("historical defense schedule identity", () => {
  it("retains the same canonical Rams franchise ahead of LAC when tied source names normalize", () => {
    const select = (team: string) =>
      selectHistoricalRosDefenses({
        history: [outcome(2022, 1, "LAC"), outcome(2022, 1, team)],
        season: 2022,
        asOfWeek: 1,
        teams: 1,
        scoringProfile: HISTORICAL_ROS_SCORING_PROFILE,
      });
    expect(select("LA")).toEqual(select("LAR"));
    expect(select("LA")).toEqual([expect.objectContaining({ team: "LAR" })]);
  });

  it.each([
    ["LA", "LAR"],
    ["STL", "LAR"],
    ["OAK", "LV"],
    ["SD", "LAC"],
    ["WSH", "WAS"],
  ])("joins source %s schedules with canonical %s history", (source, canonical) => {
    const history = [outcome(2022, 1, canonical)];
    const schedules = [game(2022, 1, source), game(2022, 2, source)];
    const prepared = prepareHistoricalRosDefenseSchedule(history, schedules);
    expect(prepared.byTeamWeek.get(`2022:2:${canonical}`)).toMatchObject({
      awayTeam: canonical,
      homeTeam: "SEA",
    });
    expect(prepared.history).toEqual(history);
    expect(schedules[0]!.awayTeam).toBe(source);
  });

  it("normalizes history opponents and leaves unrelated seasons and teams outside its scope", () => {
    const prepared = prepareHistoricalRosDefenseSchedule(
      [outcome(2022, 1, "LA", "WSH")],
      [game(2022, 1, "LAR", "WAS"), game(2021, 1, "AAA", "BBB"), game(2022, 1, "AAA", "BBB")],
    );
    expect(prepared.history[0]).toMatchObject({ team: "LAR", opponent: "WAS" });
    expect(prepared.byTeamWeek.size).toBe(1);
  });

  it("accepts omitted opponent evidence and played=false canceled or missing actual rows", () => {
    const { opponent, ...withoutOpponent } = outcome();
    void opponent;
    const prepared = prepareHistoricalRosDefenseSchedule(
      [withoutOpponent, { ...outcome(2022, 2), played: false }],
      [game()],
    );
    expect(prepared.byTeamWeek.has("2022:1:LAR")).toBe(true);
    expect(prepared.byTeamWeek.has("2022:2:LAR")).toBe(false);
  });

  it.each([
    ["missing", [outcome()], [], "Missing historical defense schedule"],
    ["opponent mismatch", [outcome()], [game(2022, 1, "LA", "SF")], "opponent mismatch"],
    [
      "duplicate schedule",
      [outcome()],
      [game(), game(2022, 1, "LAR", "SF")],
      "Ambiguous historical defense schedule",
    ],
    [
      "duplicate history",
      [outcome(), outcome(2022, 1, "LA")],
      [game()],
      "Duplicate historical defense outcome",
    ],
  ] as const)(
    "rejects %s evidence before any fitting or projection",
    async (_, history, schedules, message) => {
      const projectionEvaluator = vi.fn(async () => {
        throw new Error("must not simulate");
      });
      const onProgress = vi.fn();
      await expect(
        buildHistoricalRosBacktest({
          ...fixture(),
          defenseHistory: history,
          schedules,
          projectionEvaluator,
          onProgress,
        }),
      ).rejects.toThrow(message);
      expect(projectionEvaluator).not.toHaveBeenCalled();
      expect(onProgress).not.toHaveBeenCalled();
    },
  );

  it("assembles identical nonzero DST inputs from raw or canonical Rams schedules", async () => {
    const source = fixture();
    const stop = new Error("input captured without simulation");
    const capture = async (input: HistoricalRosBacktestInput) => {
      const inputs: FirstPartyRosProjectionInput[] = [];
      await expect(
        buildHistoricalRosBacktest({
          ...input,
          projectionEvaluator: async (candidate) => {
            inputs.push(candidate);
            throw stop;
          },
        }),
      ).rejects.toBe(stop);
      return inputs;
    };
    const raw = await capture(source);
    const canonical = await capture({
      ...source,
      schedules: source.schedules.map((row) => ({ ...row, awayTeam: "LAR" })),
    });
    expect(raw).toEqual(canonical);
    expect(raw).toHaveLength(2);
    expect(raw[0]!.playerId).toBe("DST:LAR");
    expect(raw[0]!.weeks.map((week) => [week.week, week.scheduled, week.bye])).toEqual([
      [17, true, false],
      [18, true, false],
    ]);
    expect(HISTORICAL_ROS_DEFENSE_INPUT_VERSION).toBe("historical-ros-defense-football-input-v5");
    expect(HISTORICAL_ROS_DEFENSE_SCHEDULE_VERSION).toBe("historical-defense-schedule-assembly-v1");
  });
});
