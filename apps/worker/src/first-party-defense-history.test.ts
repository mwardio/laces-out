import { describe, expect, it } from "vitest";
import { completeDefenseScoringEvents } from "./defense-scoring.test-fixtures.js";
import {
  buildFirstPartyDefenseHistory,
  requireFirstPartyDefenseHistoryForProfile,
  type ProjectionScheduleFact,
  type ProjectionTeamWeekFact,
} from "./first-party-projection-inputs.js";
import {
  canonicalFirstPartyTeamDefenseOutcomes,
  type FirstPartyTeamDefenseWeeklyStatLine,
} from "@laces-out/projections";

describe("defense history scoring definition boundary", () => {
  const observed: FirstPartyTeamDefenseWeeklyStatLine = {
    team: "BUF",
    season: 2025,
    week: 1,
    pointsAllowedDefinition: "espn-2019-v1",
    components: { points_allowed: 20 },
  };

  it.each([
    { statId: "points_allowed", points: -0.1 },
    { statId: "points_allowed_0_probability", points: 10 },
    { statId: "points_allowed", points: 0, bonuses: [{ atLeast: 20, points: -2 }] },
  ])("requires explicit meaning for an active $statId rule", (rule) => {
    expect(() =>
      requireFirstPartyDefenseHistoryForProfile([observed], { id: "legacy", rules: [rule] }),
    ).toThrow("requires an explicit definition");
    expect(
      requireFirstPartyDefenseHistoryForProfile([observed], {
        id: "espn",
        rules: [{ ...rule, statDefinition: "espn-2019-v1" }],
      }),
    ).toBe("espn-2019-v1");
    expect(() =>
      requireFirstPartyDefenseHistoryForProfile([observed], {
        id: "yahoo",
        rules: [{ ...rule, statDefinition: "yahoo-2022-v1" }],
      }),
    ).toThrow("Defense history points-allowed definition does not match the scoring profile");
  });

  it("ignores unplayed rows and scoring rules that do not price points allowed", () => {
    expect(
      requireFirstPartyDefenseHistoryForProfile([{ ...observed, played: false }], {
        id: "yahoo",
        rules: [{ statId: "points_allowed", points: -0.1, statDefinition: "yahoo-2022-v1" }],
      }),
    ).toBe("yahoo-2022-v1");
    expect(
      requireFirstPartyDefenseHistoryForProfile([observed], {
        id: "sacks",
        rules: [
          { statId: "defensive_sacks", points: 1 },
          { statId: "points_allowed", points: 0 },
        ],
      }),
    ).toBeNull();
  });

  it("preserves provider semantics through canonical outcome assembly", () => {
    const canonical = canonicalFirstPartyTeamDefenseOutcomes([observed]);
    expect(
      requireFirstPartyDefenseHistoryForProfile(canonical, {
        id: "espn",
        rules: [{ statId: "points_allowed", points: -0.1, statDefinition: "espn-2019-v1" }],
      }),
    ).toBe("espn-2019-v1");
  });
});

function game(input: {
  readonly historical: string;
  readonly current: string;
  readonly home: boolean;
  readonly historicalStats?: boolean;
}): { teams: ProjectionTeamWeekFact[]; schedules: ProjectionScheduleFact[] } {
  const identity = { season: 2019, week: 1, gameId: `2019_01_${input.historical}_GB` };
  const team = input.historicalStats ? input.historical : input.current;
  return {
    teams: [
      {
        ...identity,
        team,
        opponentTeam: "GB",
        components: {
          ...completeDefenseScoringEvents({
            scoring_event_defensive_interception_touchdown: 1,
            scoring_event_safety: 1,
            scoring_event_field_goal: 3,
          }),
          defensive_sacks: 3,
          defensive_touchdowns: 1,
          defensive_safeties: 1,
          total_offensive_yards: 275,
        },
      },
      {
        ...identity,
        team: "GB",
        // Deliberately mix aliases between reciprocal records.
        opponentTeam: input.historicalStats ? input.current : input.historical,
        components: {
          ...completeDefenseScoringEvents({
            scoring_event_defensive_interception_touchdown: 1,
            scoring_event_safety: 1,
            scoring_event_offensive_pass_touchdown: 3,
            scoring_event_field_goal: 1,
            scoring_event_extra_point: 2,
          }),
          defensive_touchdowns: 1,
          defensive_safeties: 1,
          total_offensive_yards: 341,
          field_goals_blocked: 1,
          extra_points_blocked: 0,
          punts_blocked: 1,
        },
      },
    ],
    schedules: [
      {
        ...identity,
        awayTeam: input.home ? "GB" : input.historical,
        homeTeam: input.home ? input.historical : "GB",
        awayScore: input.home ? 31 : 17,
        homeScore: input.home ? 17 : 31,
        status: "final",
      },
    ],
  };
}

describe("historical defense schedule joins", () => {
  it.each(
    [
      { historical: "OAK", current: "LV" },
      { historical: "SD", current: "LAC" },
      { historical: "STL", current: "LAR" },
      { historical: "LA", current: "LAR" },
    ].flatMap((alias) =>
      [false, true].flatMap((home) =>
        [false, true].map((historicalStats) => ({ ...alias, home, historicalStats })),
      ),
    ),
  )(
    "preserves both sides of $historical/$current, home=$home, old stats=$historicalStats",
    (input) => {
      const { teams, schedules } = game(input);
      const originalFacts = JSON.stringify({ teams, schedules });
      const result = buildFirstPartyDefenseHistory(teams, schedules, "yahoo-2022-v1");
      expect(result).toHaveLength(2);
      expect(result.find((row) => row.team === input.current)).toMatchObject({
        team: input.current,
        opponent: "GB",
        season: 2019,
        week: 1,
        played: true,
        components: {
          defensive_sacks: 3,
          defensive_touchdowns: 1,
          defensive_safeties: 1,
          defensive_blocked_kicks: 2,
          points_allowed: 23,
          yards_allowed: 341,
        },
      });
      expect(result.find((row) => row.team === "GB")).toMatchObject({
        team: "GB",
        opponent: input.current,
        components: { points_allowed: 9, yards_allowed: 275 },
      });
      // Franchise matching must never rewrite the pinned provider records or raw game IDs.
      expect(JSON.stringify({ teams, schedules })).toBe(originalFacts);
    },
  );

  it("recovers all sixteen Oakland games without rewriting their provider game identities", () => {
    const games = Array.from({ length: 16 }, (_, index) => {
      const input = game({ historical: "OAK", current: "LV", home: index % 2 === 0 });
      const identity = { week: index + 1, gameId: `2019_${index + 1}_OAK_GB` };
      return {
        teams: input.teams.map((row) => ({ ...row, ...identity })),
        schedules: input.schedules.map((row) => ({ ...row, ...identity })),
      };
    });
    const result = buildFirstPartyDefenseHistory(
      games.flatMap((row) => row.teams),
      games.flatMap((row) => row.schedules),
      "yahoo-2022-v1",
    );
    expect(result).toHaveLength(32);
    expect(result.filter((row) => row.team === "LV").map((row) => row.week)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    expect(result.every((row) => row.season === 2019)).toBe(true);
  });

  it.each(["UNKNOWN", "OAKLAND", "AAA", ""])(
    "rejects the unsupported alias %j even when raw records agree",
    (unknown) => {
      const input = game({ historical: unknown, current: unknown, home: false });
      expect(buildFirstPartyDefenseHistory(input.teams, input.schedules, "yahoo-2022-v1")).toEqual(
        [],
      );
    },
  );

  it("requires the exact original game ID, without alias replacement inside provider IDs", () => {
    const input = game({ historical: "OAK", current: "LV", home: false });
    expect(
      buildFirstPartyDefenseHistory(
        input.teams,
        input.schedules.map((row) => ({ ...row, gameId: "2019_01_LV_GB" })),
        "yahoo-2022-v1",
      ),
    ).toEqual([]);
  });

  it("does not attach a score from an unrelated scheduled opponent", () => {
    const input = game({ historical: "OAK", current: "LV", home: false });
    expect(
      buildFirstPartyDefenseHistory(
        input.teams,
        input.schedules.map((row) => ({ ...row, homeTeam: "DEN" })),
        "yahoo-2022-v1",
      ),
    ).toEqual([]);
  });

  it("requires reciprocal team rows rather than guessing the opponent", () => {
    const input = game({ historical: "OAK", current: "LV", home: false });
    const teams = input.teams.map((row) =>
      row.team === "GB" ? { ...row, opponentTeam: "DEN" } : row,
    );
    expect(buildFirstPartyDefenseHistory(teams, input.schedules, "yahoo-2022-v1")).toEqual([]);
    expect(
      buildFirstPartyDefenseHistory(input.teams.slice(0, 1), input.schedules, "yahoo-2022-v1"),
    ).toEqual([]);
  });

  it.each(["season", "week"] as const)(
    "does not cross a mismatched %s in a source join",
    (field) => {
      const input = game({ historical: "OAK", current: "LV", home: false });
      expect(
        buildFirstPartyDefenseHistory(
          input.teams,
          input.schedules.map((row) => ({ ...row, [field]: row[field] + 1 })),
          "yahoo-2022-v1",
        ),
      ).toEqual([]);
      expect(
        buildFirstPartyDefenseHistory(
          input.teams.map((row) => (row.team === "GB" ? { ...row, [field]: row[field] + 1 } : row)),
          input.schedules,
          "yahoo-2022-v1",
        ),
      ).toEqual([]);
    },
  );

  it("does not impute missing final scores", () => {
    const input = game({ historical: "OAK", current: "LV", home: false });
    expect(
      buildFirstPartyDefenseHistory(
        input.teams,
        input.schedules.map((row) => ({ ...row, awayScore: null, homeScore: null })),
        "yahoo-2022-v1",
      ),
    ).toEqual([]);
  });
});

describe("observed provider-specific defense history", () => {
  function opener() {
    const identity = { season: 2023, week: 1, gameId: "2023_01_DAL_NYG" };
    const teams: ProjectionTeamWeekFact[] = [
      {
        ...identity,
        team: "DAL",
        opponentTeam: "NYG",
        components: {
          ...completeDefenseScoringEvents({
            scoring_event_offensive_pass_touchdown: 2,
            scoring_event_offensive_rush_touchdown: 2,
            scoring_event_defensive_interception_touchdown: 1,
            scoring_event_blocked_field_goal_touchdown: 1,
            scoring_event_extra_point: 4,
          }),
          // Stale raw aggregate values must not override the complete observed ledger.
          defensive_touchdowns: 99,
          special_teams_touchdowns: 99,
          defensive_sacks: 7,
          defensive_interceptions: 2,
          defensive_fumbles_recovered: 1,
          total_offensive_yards: 265,
        },
      },
      {
        ...identity,
        team: "NYG",
        opponentTeam: "DAL",
        components: {
          ...completeDefenseScoringEvents({}),
          total_offensive_yards: 171,
        },
      },
    ];
    const schedules: ProjectionScheduleFact[] = [
      {
        ...identity,
        awayTeam: "DAL",
        homeTeam: "NYG",
        awayScore: 40,
        homeScore: 0,
        status: "final",
      },
    ];
    return { teams, schedules };
  }

  it("derives distinct Yahoo and ESPN PA from one complete neutral score ledger", () => {
    const { teams, schedules } = opener();
    const yahoo = buildFirstPartyDefenseHistory(teams, schedules, "yahoo-2022-v1");
    const espn = buildFirstPartyDefenseHistory(teams, schedules, "espn-2019-v1");
    expect(yahoo.find((row) => row.team === "NYG")).toMatchObject({
      pointsAllowedDefinition: "yahoo-2022-v1",
      components: { points_allowed: 28 },
    });
    expect(espn.find((row) => row.team === "NYG")).toMatchObject({
      pointsAllowedDefinition: "espn-2019-v1",
      components: { points_allowed: 34 },
    });
    for (const history of [yahoo, espn]) {
      expect(history.find((row) => row.team === "DAL")?.components).toMatchObject({
        defensive_touchdowns: 1,
        special_teams_touchdowns: 1,
        defensive_two_point_returns: 0,
        one_point_safeties: 0,
        points_allowed: 0,
      });
    }
  });

  it("retains observed rare scores instead of the forecast's zero approximation", () => {
    const input = opener();
    const teams = input.teams.map((row) =>
      row.team === "DAL"
        ? {
            ...row,
            components: completeDefenseScoringEvents({
              scoring_event_defensive_fumble_touchdown: 1,
              scoring_event_defensive_two_point_return: 1,
              scoring_event_one_point_safety: 1,
            }),
          }
        : row,
    );
    const schedules = input.schedules.map((row) => ({ ...row, awayScore: 9 }));
    const history = buildFirstPartyDefenseHistory(teams, schedules, "yahoo-2022-v1");
    expect(history.find((row) => row.team === "DAL")?.components).toMatchObject({
      defensive_touchdowns: 1,
      defensive_two_point_returns: 1,
      one_point_safeties: 1,
    });
    expect(history.find((row) => row.team === "NYG")?.components.points_allowed).toBe(0);
    const espn = buildFirstPartyDefenseHistory(teams, schedules, "espn-2019-v1");
    expect(espn.find((row) => row.team === "NYG")?.components).not.toHaveProperty("points_allowed");
    expect(espn.find((row) => row.team === "DAL")?.components.defensive_touchdowns).toBe(1);
  });

  it.each(["scoring_event_totals_complete", "scoring_event_defensive_fumble_touchdown"])(
    "retains rows but withholds unobserved scoring when %s is absent",
    (missing) => {
      const { teams, schedules } = opener();
      const partial = teams.map((row) => {
        if (row.team !== "DAL") return row;
        const components = { ...row.components };
        delete components[missing];
        return { ...row, components };
      });
      const history = buildFirstPartyDefenseHistory(partial, schedules, "yahoo-2022-v1");
      expect(history).toHaveLength(2);
      expect(history.find((row) => row.team === "DAL")?.components).not.toHaveProperty(
        "defensive_touchdowns",
      );
      expect(history.find((row) => row.team === "NYG")?.components).not.toHaveProperty(
        "points_allowed",
      );
      expect(history.find((row) => row.team === "DAL")?.components.defensive_sacks).toBe(7);
    },
  );

  it("does not impute absent blocked kicks, invalid sacks, or mismatched scoreboard points", () => {
    const { teams, schedules } = opener();
    const partial = teams.map((row) => ({
      ...row,
      components: { ...row.components, defensive_sacks: -1 },
    }));
    const history = buildFirstPartyDefenseHistory(
      partial,
      schedules.map((row) => ({ ...row, awayScore: 5 })),
      "yahoo-2022-v1",
    );
    expect(history).toHaveLength(2);
    for (const row of history) {
      expect(row.components).not.toHaveProperty("defensive_sacks");
      expect(row.components).not.toHaveProperty("defensive_blocked_kicks");
    }
    expect(history.find((row) => row.team === "NYG")?.components).not.toHaveProperty(
      "points_allowed",
    );
  });

  it("does not train from a game explicitly marked in progress", () => {
    const { teams, schedules } = opener();
    expect(
      buildFirstPartyDefenseHistory(
        teams,
        schedules.map((row) => ({ ...row, status: "in-progress" })),
        "yahoo-2022-v1",
      ),
    ).toEqual([]);
  });
});
