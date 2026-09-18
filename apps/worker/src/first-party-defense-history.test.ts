import { describe, expect, it } from "vitest";
import {
  buildFirstPartyDefenseHistory,
  type ProjectionScheduleFact,
  type ProjectionTeamWeekFact,
} from "./first-party-projection-inputs.js";

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
      const result = buildFirstPartyDefenseHistory(teams, schedules);
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
      expect(buildFirstPartyDefenseHistory(input.teams, input.schedules)).toEqual([]);
    },
  );

  it("requires the exact original game ID, without alias replacement inside provider IDs", () => {
    const input = game({ historical: "OAK", current: "LV", home: false });
    expect(
      buildFirstPartyDefenseHistory(
        input.teams,
        input.schedules.map((row) => ({ ...row, gameId: "2019_01_LV_GB" })),
      ),
    ).toEqual([]);
  });

  it("does not attach a score from an unrelated scheduled opponent", () => {
    const input = game({ historical: "OAK", current: "LV", home: false });
    expect(
      buildFirstPartyDefenseHistory(
        input.teams,
        input.schedules.map((row) => ({ ...row, homeTeam: "DEN" })),
      ),
    ).toEqual([]);
  });

  it("requires reciprocal team rows rather than guessing the opponent", () => {
    const input = game({ historical: "OAK", current: "LV", home: false });
    const teams = input.teams.map((row) =>
      row.team === "GB" ? { ...row, opponentTeam: "DEN" } : row,
    );
    expect(buildFirstPartyDefenseHistory(teams, input.schedules)).toEqual([]);
    expect(buildFirstPartyDefenseHistory(input.teams.slice(0, 1), input.schedules)).toEqual([]);
  });

  it.each(["season", "week"] as const)(
    "does not cross a mismatched %s in a source join",
    (field) => {
      const input = game({ historical: "OAK", current: "LV", home: false });
      expect(
        buildFirstPartyDefenseHistory(
          input.teams,
          input.schedules.map((row) => ({ ...row, [field]: row[field] + 1 })),
        ),
      ).toEqual([]);
      expect(
        buildFirstPartyDefenseHistory(
          input.teams.map((row) => (row.team === "GB" ? { ...row, [field]: row[field] + 1 } : row)),
          input.schedules,
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
      ),
    ).toEqual([]);
  });
});
